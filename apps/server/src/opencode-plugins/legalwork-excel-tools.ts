import { z } from "zod";

import {
  callOfficeTool,
  describeOpenDocument,
  describeOtherOpenApps,
  officePaneForHost,
  type OpenCodeContext,
} from "./office-plugin-shared.js";

/**
 * Agent tools for the Microsoft Excel workbook open next to the LegalWork
 * task pane. Same relay as the Word tools; the pane executes via Excel.js.
 *
 * Excel has no tracked-changes API, so the safety pattern differs from
 * Word: every agent write highlights the touched cells so the user sees
 * exactly what changed, and the agent explains edits with cell comments.
 */

const EXCEL_TOOL_RULES = `Rules for excel_* tools:
- Call excel_read_workbook first to learn the sheets, then excel_read_range for the data you need. Cell addresses (e.g. "Sheet1!B2:D10") are the anchors — always reference exact addresses.
- Writes highlight the touched cells so the user sees what changed. Do not disable the highlight unless the user asks.
- Excel has no tracked changes: be conservative. Never overwrite data you have not read first; put derived analysis on a new worksheet (excel_add_worksheet) instead of squeezing it between existing data.
- Attach a short excel_add_comment on written cells for substantive changes (assumptions, formulas, sources).
- After editing, summarize what you wrote and where in one or two sentences.
- excel_run_code executes raw Office.js for anything the typed tools cannot do (number formats, charts, tables, conditional formatting, sorting). Prefer the typed tools when they fit; keep the highlight-and-report discipline for any cell you change.
- If a tool answers "No Office pane is connected", tell the user to open the LegalWork pane in Excel and retry.`;

/** Injected when no pane is connected: the tools exist but may be offline. */
const EXCEL_TOOLS_INSTRUCTION = `## Microsoft Excel workbook tools
The user may work with the LegalWork pane open inside Microsoft Excel. The excel_* tools read and edit the workbook that is currently open in Excel.

${EXCEL_TOOL_RULES}`;

/** Injected when an Excel pane is live: switch to workbook-first behavior. */
const excelModeInstruction = (documentUrl: string | null) => `## You are working inside Microsoft Excel right now
The user has the LegalWork pane open inside Microsoft Excel with a workbook next to the chat. ${describeOpenDocument(documentUrl)} Behave accordingly:

- Assume data-related requests refer to the open workbook. Orient with excel_read_workbook, then read the relevant ranges before answering.
- Prefer excel_* tools for workbook work over editing files in the workspace.
- The chat is a narrow sidebar: keep replies short and skimmable, and do not paste large ranges back into the chat — the user can see the workbook.

${EXCEL_TOOL_RULES}`;

const readRangeArgs = z.object({
  sheet: z.string().optional().describe("Worksheet name. Defaults to the active sheet."),
  range: z.string().optional().describe('Range address like "B2:D10". Defaults to the sheet\'s used range.'),
  include_formulas: z.boolean().optional().describe("Also return the formulas of the range."),
});

const writeCellsArgs = z.object({
  sheet: z.string().optional().describe("Worksheet name. Defaults to the active sheet."),
  start_cell: z.string().describe('Top-left cell to write at, e.g. "B2".'),
  values: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .describe("Rectangular 2D array of rows to write. Strings starting with '=' are only treated as formulas when as_formulas is true."),
  as_formulas: z.boolean().optional().describe("Write the values as formulas (strings like \"=SUM(A1:A5)\")."),
  highlight: z.boolean().optional().describe("Highlight written cells so the user sees the change. Defaults to true; keep it on."),
});

const highlightArgs = z.object({
  sheet: z.string().optional().describe("Worksheet name. Defaults to the active sheet."),
  range: z.string().describe('Range address to highlight, e.g. "B2:D5".'),
  color: z.string().optional().describe("Hex fill color like #FFF3BF (default: amber)."),
});

const addWorksheetArgs = z.object({
  name: z.string().min(1).max(31).describe("Name of the new worksheet (max 31 chars, no []:*?/\\)."),
});

const searchArgs = z.object({
  query: z.string().min(1).describe("Text to find in cell contents."),
  sheet: z.string().optional().describe("Limit the search to one worksheet."),
  match_case: z.boolean().optional().describe("Case-sensitive matching. Defaults to false."),
});

const addCommentArgs = z.object({
  cell: z.string().describe('Cell for the comment, e.g. "B4" or "Sheet1!B4".'),
  sheet: z.string().optional().describe("Worksheet name when cell has no sheet prefix. Defaults to the active sheet."),
  comment: z.string().min(1).describe("The comment text, e.g. assumptions or rationale for a nearby edit."),
});

const runCodeArgs = z.object({
  code: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "Body of an Excel.run batch. In scope: context (Excel.RequestContext), the Office/Excel globals, and console.log for debugging. Load properties before reading them and await context.sync(); a final sync runs automatically. End with `return <json-serializable summary>`.",
    ),
});

export const LegalWorkExcelTools = async () => ({
  "experimental.chat.system.transform": async (
    _input: unknown,
    output: { system: string[] },
  ) => {
    const pane = await officePaneForHost("excel");
    output.system.push(
      pane ? excelModeInstruction(pane.documentUrl) + (await describeOtherOpenApps("excel")) : EXCEL_TOOLS_INSTRUCTION,
    );
  },
  tool: {
    excel_read_workbook: {
      description:
        "Get an overview of the Excel workbook open next to the LegalWork pane: worksheet names, their used ranges and sizes, and the active sheet. Call this first to orient before reading or writing data.",
      args: {},
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_read_workbook", {});
      },
    },
    excel_read_range: {
      description:
        "Read cell values (optionally formulas) from the open Excel workbook — a specific range or a sheet's whole used range. Large ranges are rejected with the dimensions so you can request a narrower window.",
      args: readRangeArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_read_range", readRangeArgs.parse(rawArgs ?? {}));
      },
    },
    excel_read_selection: {
      description: "Read the cells the user currently has selected in Excel (values and address).",
      args: {},
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_read_selection", {});
      },
    },
    excel_write_cells: {
      description:
        "Write a rectangular block of values (or formulas with as_formulas) into the open Excel workbook starting at start_cell. Written cells are highlighted so the user sees the change. Read the target area first; never overwrite unread data.",
      args: writeCellsArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_write_cells", writeCellsArgs.parse(rawArgs));
      },
    },
    excel_highlight_range: {
      description: "Highlight a range with a fill color, e.g. to flag cells for the user's attention without changing values.",
      args: highlightArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_highlight_range", highlightArgs.parse(rawArgs));
      },
    },
    excel_add_worksheet: {
      description: "Add a new worksheet to the open workbook — the right place for derived analysis, summaries, or review grids.",
      args: addWorksheetArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_add_worksheet", addWorksheetArgs.parse(rawArgs));
      },
    },
    excel_search: {
      description: "Search cell contents across the workbook (or one sheet) and get the matching addresses per sheet.",
      args: searchArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_search", searchArgs.parse(rawArgs));
      },
    },
    excel_add_comment: {
      description: "Attach a comment to a cell in the open workbook, e.g. to explain an assumption or a change you made nearby.",
      args: addCommentArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_add_comment", addCommentArgs.parse(rawArgs));
      },
    },
    excel_run_code: {
      description:
        "Escape hatch: run Office.js (Excel JavaScript API) code against the open workbook for anything the typed excel_* tools cannot do — number formats, charts, tables, conditional formatting, sorting/filtering, column widths. Excel has NO revision tracking: shade cells you modify with #FFF3BF like the typed tools do, never overwrite data you have not read, and report every change. Errors return the Office.js debugInfo so you can fix the snippet and retry. Prefer the typed tools when they fit.",
      args: runCodeArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        return callOfficeTool(context, "excel_run_code", runCodeArgs.parse(rawArgs));
      },
    },
  },
});
