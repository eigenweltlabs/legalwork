import { z } from "zod";

import {
  callOfficeTool,
  describeOpenDocument,
  describeOtherOpenApps,
  officePaneForHost,
  type OpenCodeContext,
} from "./office-plugin-shared.js";

/**
 * Agent tools for editing the Microsoft Word document that is open next to
 * the LegalWork task pane. Runs over the shared office-tools relay; the
 * pane executes via Office.js (see office-plugin-shared.ts for the path).
 *
 * All mutating tools force Word's change tracking on, so every agent edit
 * shows up as a native tracked change the user can accept or reject.
 */

const WORD_TOOL_RULES = `Rules for word_* tools:
- Call word_read_document before editing so anchors are exact.
- Anchors are short snippets (under 200 characters) copied VERBATIM from the document — including punctuation and casing. Prefer distinctive phrases; if an anchor matches several places, the tool reports the count and you must pass "occurrence".
- Every edit is applied as a tracked change (redline). Never claim you changed text silently; the user reviews and accepts each change in Word.
- After substantive edits, add a short word_add_comment on the edited text explaining the reasoning, like a careful colleague would.
- word_run_code executes raw Office.js for anything the typed tools cannot do (formatting, styles, tables, headers/footers, sections). Prefer the typed tools when they fit; keep snippets small and return a compact summary.
- If a tool answers "No Office pane is connected", tell the user to open the LegalWork pane in Word and retry.`;

/** Injected when no pane is connected: the tools exist but may be offline. */
const WORD_TOOLS_INSTRUCTION = `## Microsoft Word document tools
The user may work with the LegalWork pane open inside Microsoft Word. The word_* tools read and edit the document that is currently open in Word.

${WORD_TOOL_RULES}`;

/** Injected when a Word pane is live: switch to document-first behavior. */
const wordModeInstruction = (documentUrl: string | null) => `## You are working inside Microsoft Word right now
The user has the LegalWork pane open inside Microsoft Word with a document next to the chat. ${describeOpenDocument(documentUrl)} Behave accordingly:

- Assume document-related requests refer to the open Word document. Read it with word_read_document before answering questions about "the document", "the contract", or similar.
- Prefer word_* tools for document work over editing files in the workspace. Apply changes as tracked redlines (word_replace_text / word_insert_text) and attach a short word_add_comment rationale to each substantive edit.
- The chat is a narrow sidebar: keep replies short and skimmable. Lead with what you did or found, avoid wide tables and long headed sections, and do not paste large document excerpts back into the chat — the user can see the document.
- After editing, summarize the redlines in one or two sentences and remind the user to review and accept or reject them in Word.

${WORD_TOOL_RULES}`;

const readDocumentArgs = z.object({
  max_chars: z
    .number()
    .int()
    .min(1_000)
    .max(200_000)
    .optional()
    .describe("Maximum number of characters to return. Defaults to 30000; the result reports if it was truncated."),
});

const searchArgs = z.object({
  query: z.string().min(1).max(240).describe("Text to find in the document, verbatim."),
  match_case: z.boolean().optional().describe("Case-sensitive matching. Defaults to true."),
  max_results: z.number().int().min(1).max(50).optional().describe("Maximum matches to return with context. Defaults to 10."),
});

const replaceArgs = z.object({
  anchor: z.string().min(1).max(240).describe("Exact text to replace, copied verbatim from the document (max 240 chars)."),
  replacement: z.string().describe("The new text. An empty string deletes the anchor text."),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based occurrence to replace when the anchor appears multiple times. Omit when the anchor is unique."),
});

const insertArgs = z.object({
  location: z
    .enum(["document_start", "document_end", "before_anchor", "after_anchor"])
    .describe("Where to insert the text."),
  anchor: z
    .string()
    .min(1)
    .max(240)
    .optional()
    .describe("Required for before_anchor/after_anchor: exact text from the document to insert next to."),
  occurrence: z.number().int().min(1).optional().describe("1-based anchor occurrence when it appears multiple times."),
  text: z.string().min(1).describe("The text to insert."),
});

const commentArgs = z.object({
  anchor: z.string().min(1).max(240).describe("Exact text from the document the comment should attach to."),
  occurrence: z.number().int().min(1).optional().describe("1-based anchor occurrence when it appears multiple times."),
  comment: z.string().min(1).describe("The comment text, e.g. the rationale for a nearby edit."),
});

const runCodeArgs = z.object({
  code: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "Body of a Word.run batch. In scope: context (Word.RequestContext), the Office/Word globals, and console.log for debugging. Load properties before reading them and await context.sync(); a final sync runs automatically. End with `return <json-serializable summary>`.",
    ),
});

export const LegalWorkWordTools = async () => ({
  "experimental.chat.system.transform": async (
    _input: unknown,
    output: { system: string[] },
  ) => {
    const pane = await officePaneForHost("word");
    output.system.push(
      pane ? wordModeInstruction(pane.documentUrl) + (await describeOtherOpenApps("word")) : WORD_TOOLS_INSTRUCTION,
    );
  },
  tool: {
    word_read_document: {
      description:
        "Read the text of the Microsoft Word document currently open next to the LegalWork pane. Returns the document text (possibly truncated), its length, and the document URL. Use this before any edit so anchors are exact.",
      args: readDocumentArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = readDocumentArgs.parse(rawArgs ?? {});
        return callOfficeTool(context, "word_read_document", args);
      },
    },
    word_read_selection: {
      description: "Read the text the user currently has selected in the Word document.",
      args: {},
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "word_read_selection", {});
      },
    },
    word_search: {
      description:
        "Search the Word document for exact text and return each match with its surrounding paragraph, so you can pick the right occurrence before editing.",
      args: searchArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = searchArgs.parse(rawArgs);
        return callOfficeTool(context, "word_search", args);
      },
    },
    word_replace_text: {
      description:
        "Replace exact text in the Word document as a tracked change (redline). The anchor must be copied verbatim from the document. If the anchor matches multiple places, the tool reports the count and you must pass occurrence. An empty replacement deletes the text.",
      args: replaceArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = replaceArgs.parse(rawArgs);
        return callOfficeTool(context, "word_replace_text", args);
      },
    },
    word_insert_text: {
      description:
        "Insert text into the Word document as a tracked change — at the start/end of the document, or before/after an exact anchor text.",
      args: insertArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = insertArgs.parse(rawArgs);
        if ((args.location === "before_anchor" || args.location === "after_anchor") && !args.anchor) {
          return JSON.stringify({ ok: false, error: "anchor is required for before_anchor/after_anchor" });
        }
        return callOfficeTool(context, "word_insert_text", args);
      },
    },
    word_add_comment: {
      description:
        "Attach a Word comment to exact text in the document, e.g. to explain the rationale for a tracked change you just made.",
      args: commentArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = commentArgs.parse(rawArgs);
        return callOfficeTool(context, "word_add_comment", args);
      },
    },
    word_run_code: {
      description:
        "Escape hatch: run Office.js (Word JavaScript API) code against the open document for anything the typed word_* tools cannot do — character formatting (bold, fonts, colors, highlights), paragraph styles (headings, quotes), tables, headers/footers, sections, lists, page setup. Change tracking is forced on, so document edits appear as reviewable redlines. Errors return the Office.js debugInfo so you can fix the snippet and retry. Prefer the typed tools when they fit.",
      args: runCodeArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = runCodeArgs.parse(rawArgs);
        return callOfficeTool(context, "word_run_code", args);
      },
    },
  },
});
