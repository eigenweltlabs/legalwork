import { z } from "zod";

import {
  callOfficeTool,
  describeOpenDocument,
  describeOtherOpenApps,
  officePaneForHost,
  type OpenCodeContext,
} from "./office-plugin-shared.js";

/**
 * Agent tools for the Microsoft PowerPoint presentation open next to the
 * LegalWork task pane. Same relay as the Word/Excel tools; the pane
 * executes via PowerPoint.js.
 *
 * PowerPoint has neither tracked changes nor comments in its add-in API,
 * so the safety pattern is behavioral: the agent must report every slide
 * and shape it changed (the user can undo with Cmd+Z), and set_shape_text
 * returns the previous text so nothing is lost silently.
 */

const PPT_TOOL_RULES = `Rules for ppt_* tools:
- Call ppt_read_presentation first to see the slides and their shapes, then ppt_read_slide for detail. Slides are 1-based; shapes are addressed by exact name or 1-based index within their slide.
- Edits are direct (PowerPoint has no tracked changes): list EVERY slide and shape you changed in your reply, with a one-line before/after summary, so the user can review or undo (Cmd+Z).
- ppt_replace_text matches exact, case-sensitive text; when it matches multiple places it reports the locations and you must pass occurrence.
- Prefer editing existing shape text over adding new text boxes; use ppt_add_text_box only for genuinely new content the slide layout has no placeholder for.
- ppt_run_code executes raw Office.js (PowerPointApi) for styling, shapes, images and anything else the typed tools cannot do. The PowerPointApi is the most limited of the three Office APIs — if something is genuinely not exposed, say so instead of pretending.
- If a tool answers "No Office pane is connected", tell the user to open the LegalWork pane in PowerPoint and retry.`;

/** Injected when no pane is connected: the tools exist but may be offline. */
const PPT_TOOLS_INSTRUCTION = `## Microsoft PowerPoint presentation tools
The user may work with the LegalWork pane open inside Microsoft PowerPoint. The ppt_* tools read and edit the presentation that is currently open in PowerPoint.

${PPT_TOOL_RULES}`;

/** Injected when a PowerPoint pane is live: presentation-first behavior. */
const pptModeInstruction = (documentUrl: string | null) => `## You are working inside Microsoft PowerPoint right now
The user has the LegalWork pane open inside Microsoft PowerPoint with a presentation next to the chat. ${describeOpenDocument(documentUrl)} Behave accordingly:

- Assume slide- and deck-related requests refer to the open presentation. Orient with ppt_read_presentation before answering.
- Prefer ppt_* tools for presentation work over editing files in the workspace.
- The chat is a narrow sidebar: keep replies short and skimmable, and do not paste whole slide contents back into the chat — the user can see the slides.

${PPT_TOOL_RULES}`;

const readSlideArgs = z.object({
  slide_number: z.number().int().min(1).describe("1-based slide number."),
});

const setShapeTextArgs = z.object({
  slide_number: z.number().int().min(1).describe("1-based slide number."),
  shape: z.string().describe('Exact shape name (from ppt_read_slide) or 1-based shape index as a string, e.g. "Title 1" or "2".'),
  text: z.string().describe("The new text for the shape. An empty string clears it. The tool returns the previous text."),
});

const replaceTextArgs = z.object({
  find: z.string().min(1).describe("Exact, case-sensitive text to find in slide shapes."),
  replace: z.string().describe("Replacement text. An empty string deletes the found text."),
  slide_number: z.number().int().min(1).optional().describe("Limit the replacement to one slide."),
  occurrence: z.number().int().min(1).optional().describe("1-based occurrence when the text matches multiple places."),
});

const addTextBoxArgs = z.object({
  slide_number: z.number().int().min(1).describe("1-based slide number."),
  text: z.string().min(1).describe("Text content of the new text box."),
  left: z.number().optional().describe("Left position in points (default 50)."),
  top: z.number().optional().describe("Top position in points (default 50)."),
  width: z.number().optional().describe("Width in points (default 500)."),
  height: z.number().optional().describe("Height in points (default 100)."),
});

const runCodeArgs = z.object({
  code: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "Body of a PowerPoint.run batch. In scope: context (PowerPoint.RequestContext), the Office/PowerPoint globals, and console.log for debugging. Load properties before reading them and await context.sync(); a final sync runs automatically. End with `return <json-serializable summary>`.",
    ),
});

export const LegalWorkPowerPointTools = async () => ({
  "experimental.chat.system.transform": async (
    _input: unknown,
    output: { system: string[] },
  ) => {
    const pane = await officePaneForHost("powerpoint");
    output.system.push(
      pane ? pptModeInstruction(pane.documentUrl) + (await describeOtherOpenApps("powerpoint")) : PPT_TOOLS_INSTRUCTION,
    );
  },
  tool: {
    ppt_read_presentation: {
      description:
        "Get the text outline of the PowerPoint presentation open next to the LegalWork pane: every slide with its text-bearing shapes (name, index, text). Call this first to orient.",
      args: {},
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_read_presentation", {});
      },
    },
    ppt_read_slide: {
      description: "Read one slide in detail: all shapes with their names, indexes, and text.",
      args: readSlideArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_read_slide", readSlideArgs.parse(rawArgs));
      },
    },
    ppt_read_selection: {
      description: "Read what the user currently has selected in PowerPoint: the selected text (if any) and the selected slide numbers.",
      args: {},
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_read_selection", {});
      },
    },
    ppt_set_shape_text: {
      description:
        "Replace the entire text of one shape on a slide. Returns the previous text so the change is reviewable. Use ppt_read_slide first to get the shape name/index.",
      args: setShapeTextArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_set_shape_text", setShapeTextArgs.parse(rawArgs));
      },
    },
    ppt_replace_text: {
      description:
        "Find exact text across the presentation (or one slide) and replace one occurrence, keeping the rest of the shape text intact. Reports all match locations when ambiguous.",
      args: replaceTextArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_replace_text", replaceTextArgs.parse(rawArgs));
      },
    },
    ppt_add_slide: {
      description: "Append a new blank slide at the end of the presentation.",
      args: {},
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_add_slide", {});
      },
    },
    ppt_add_text_box: {
      description: "Add a text box to a slide (positions in points). Prefer editing existing shapes; use this for genuinely new content.",
      args: addTextBoxArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_add_text_box", addTextBoxArgs.parse(rawArgs));
      },
    },
    ppt_run_code: {
      description:
        "Escape hatch: run Office.js (PowerPoint JavaScript API) code against the open presentation for anything the typed ppt_* tools cannot do — shape formatting, fills, fonts, positions, adding/deleting shapes and slides. PowerPoint has NO tracked changes and NO comments: list every change you make with a before/after summary so the user can review or undo. Errors return the Office.js debugInfo so you can fix the snippet and retry. Prefer the typed tools when they fit.",
      args: runCodeArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "ppt_run_code", runCodeArgs.parse(rawArgs));
      },
    },
  },
});
