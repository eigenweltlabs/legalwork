import { z } from "zod";

/**
 * Agent tools for editing the Microsoft Word document that is open next to
 * the LegalWork task pane.
 *
 * Execution path: tool call -> legalwork-server word-tool relay
 * (/workspace/:id/word-tools/execute) -> the Word pane long-polling that
 * relay -> Office.js -> result back through the same chain. Office.js only
 * exists inside Word's webview, so the pane is the only place these can run.
 *
 * All mutating tools force Word's change tracking on, so every agent edit
 * shows up as a native tracked change the user can accept or reject.
 */

type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
};

const TOOL_TIMEOUT_MS = 45_000;
const WORKSPACE_CACHE_MS = 10_000;
const PANE_STATUS_CACHE_MS = 5_000;

const WORD_TOOL_RULES = `Rules for word_* tools:
- Call word_read_document before editing so anchors are exact.
- Anchors are short snippets (under 200 characters) copied VERBATIM from the document — including punctuation and casing. Prefer distinctive phrases; if an anchor matches several places, the tool reports the count and you must pass "occurrence".
- Every edit is applied as a tracked change (redline). Never claim you changed text silently; the user reviews and accepts each change in Word.
- After substantive edits, add a short word_add_comment on the edited text explaining the reasoning, like a careful colleague would.
- If a tool answers "No Word pane is connected", tell the user to open the LegalWork pane in Word and retry.`;

/** Injected when no pane is connected: the tools exist but may be offline. */
const WORD_TOOLS_INSTRUCTION = `## Microsoft Word document tools
The user may work with the LegalWork pane open inside Microsoft Word. The word_* tools read and edit the document that is currently open in Word.

${WORD_TOOL_RULES}`;

/** Injected when a Word pane is live: switch to document-first behavior. */
const WORD_MODE_INSTRUCTION = `## You are working inside Microsoft Word right now
The user has the LegalWork pane open inside Microsoft Word with a document next to the chat. Behave accordingly:

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

function serverUrl(): string {
  return String(process.env.LEGALWORK_SERVER_URL || "").replace(/\/$/, "");
}

function serverToken(): string {
  return String(process.env.LEGALWORK_SERVER_TOKEN || "");
}

type WorkspaceListPayload = {
  items?: Array<{ id?: unknown; path?: unknown }>;
};

let workspaceCache: { at: number; items: Array<{ id: string; path: string }> } | null = null;

async function listWorkspaces(): Promise<Array<{ id: string; path: string }>> {
  if (workspaceCache && Date.now() - workspaceCache.at < WORKSPACE_CACHE_MS) return workspaceCache.items;
  const response = await fetch(`${serverUrl()}/workspaces`, {
    headers: { Authorization: `Bearer ${serverToken()}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Workspace lookup failed: HTTP ${response.status}`);
  const payload = (await response.json()) as WorkspaceListPayload;
  const items = (payload.items ?? []).flatMap((item) =>
    typeof item.id === "string" && typeof item.path === "string" ? [{ id: item.id, path: item.path }] : [],
  );
  workspaceCache = { at: Date.now(), items };
  return items;
}

async function resolveWorkspaceId(context: OpenCodeContext): Promise<string> {
  const directory = context.directory?.trim() ?? "";
  const items = await listWorkspaces();
  if (directory) {
    const match =
      items.find((item) => item.path === directory) ??
      items.find((item) => directory.startsWith(`${item.path}/`));
    if (match) return match.id;
  }
  if (items.length === 1) return items[0]!.id;
  throw new Error(
    directory
      ? `No LegalWork workspace matches the working directory ${directory}.`
      : "Cannot determine the LegalWork workspace for this session.",
  );
}

let paneStatusCache: { at: number; connected: boolean } | null = null;

/**
 * True when any workspace currently has a Word pane long-polling the relay.
 * Checked per chat turn (with a short cache) so the system prompt flips to
 * document-first behavior as soon as the user opens the pane in Word.
 */
async function anyWordPaneConnected(): Promise<boolean> {
  if (paneStatusCache && Date.now() - paneStatusCache.at < PANE_STATUS_CACHE_MS) {
    return paneStatusCache.connected;
  }
  let connected = false;
  try {
    const url = serverUrl();
    const token = serverToken();
    if (url && token) {
      const items = await listWorkspaces();
      for (const item of items.slice(0, 5)) {
        const response = await fetch(
          `${url}/workspace/${encodeURIComponent(item.id)}/word-tools/status`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) },
        );
        if (!response.ok) continue;
        const payload = (await response.json()) as { connected?: unknown };
        if (payload.connected === true) {
          connected = true;
          break;
        }
      }
    }
  } catch {
    connected = false;
  }
  paneStatusCache = { at: Date.now(), connected };
  return connected;
}

async function callWordTool(
  context: OpenCodeContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const url = serverUrl();
    const token = serverToken();
    if (!url || !token) {
      return JSON.stringify({ ok: false, error: "LegalWork server connection is not configured for this engine." });
    }
    const workspaceId = await resolveWorkspaceId(context);
    const response = await fetch(`${url}/workspace/${encodeURIComponent(workspaceId)}/word-tools/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool, args, timeoutMs: TOOL_TIMEOUT_MS }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS + 10_000),
    });
    const text = await response.text();
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return JSON.stringify({ ok: false, error: text || `HTTP ${response.status}` });
    }
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export const LegalWorkWordTools = async () => ({
  "experimental.chat.system.transform": async (
    _input: unknown,
    output: { system: string[] },
  ) => {
    const connected = await anyWordPaneConnected();
    output.system.push(connected ? WORD_MODE_INSTRUCTION : WORD_TOOLS_INSTRUCTION);
  },
  tool: {
    word_read_document: {
      description:
        "Read the text of the Microsoft Word document currently open next to the LegalWork pane. Returns the document text (possibly truncated), its length, and the document URL. Use this before any edit so anchors are exact.",
      args: readDocumentArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = readDocumentArgs.parse(rawArgs ?? {});
        return callWordTool(context, "word_read_document", args);
      },
    },
    word_read_selection: {
      description: "Read the text the user currently has selected in the Word document.",
      args: {},
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        return callWordTool(context, "word_read_selection", {});
      },
    },
    word_search: {
      description:
        "Search the Word document for exact text and return each match with its surrounding paragraph, so you can pick the right occurrence before editing.",
      args: searchArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = searchArgs.parse(rawArgs);
        return callWordTool(context, "word_search", args);
      },
    },
    word_replace_text: {
      description:
        "Replace exact text in the Word document as a tracked change (redline). The anchor must be copied verbatim from the document. If the anchor matches multiple places, the tool reports the count and you must pass occurrence. An empty replacement deletes the text.",
      args: replaceArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = replaceArgs.parse(rawArgs);
        return callWordTool(context, "word_replace_text", args);
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
        return callWordTool(context, "word_insert_text", args);
      },
    },
    word_add_comment: {
      description:
        "Attach a Word comment to exact text in the document, e.g. to explain the rationale for a tracked change you just made.",
      args: commentArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = commentArgs.parse(rawArgs);
        return callWordTool(context, "word_add_comment", args);
      },
    },
  },
});
