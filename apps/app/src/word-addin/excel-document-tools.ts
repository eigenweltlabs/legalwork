/**
 * Excel.js implementations of the agent's excel_* tools.
 *
 * Contract (mirrored by the legalwork-excel-tools OpenCode plugin):
 * - Cell addresses are the anchors (precise, unlike Word's text anchors).
 * - Excel has no tracked changes API, so the safety pattern differs from
 *   Word: every agent write highlights the touched cells (amber fill) so
 *   the user can see exactly what changed, and the agent is instructed to
 *   attach comment rationale and summarize its edits.
 * - Handlers throw Error with a model-readable message; the relay client
 *   converts that into { ok: false, error } for the tool result.
 */
import {
  excelRun,
  isExcelApiSupported,
  type ExcelRange,
  type ExcelRunContext,
  type ExcelWorksheet,
} from "./excel-api";
import { getDocumentUrl } from "./office";
import { runOfficeCode } from "./office-run-code";
import type { WordToolHandler } from "./word-document-tools";

const MAX_READ_CELLS = 5_000;
const MAX_WRITE_CELLS = 2_000;
const MAX_SEARCH_SHEETS = 20;
const HIGHLIGHT_COLOR = "#FFF3BF";

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveWorksheet(context: ExcelRunContext, sheetName: string | undefined): Promise<ExcelWorksheet> {
  const worksheet = sheetName
    ? context.workbook.worksheets.getItem(sheetName)
    : context.workbook.worksheets.getActiveWorksheet();
  worksheet.load("name");
  await context.sync();
  return worksheet;
}

function ensureReadableSize(range: ExcelRange): void {
  const cells = range.rowCount * range.columnCount;
  if (cells > MAX_READ_CELLS) {
    throw new Error(
      `Range ${range.address} has ${cells} cells (max ${MAX_READ_CELLS} per read). Request a narrower range.`,
    );
  }
}

async function readWorkbook(): Promise<unknown> {
  return excelRun(async (context) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load("items/name");
    const active = worksheets.getActiveWorksheet();
    active.load("name");
    await context.sync();

    const usedRanges = worksheets.items.map((sheet) => {
      const used = sheet.getUsedRangeOrNullObject(true);
      used.load("address,rowCount,columnCount");
      return { sheet, used };
    });
    await context.sync();

    return {
      documentUrl: getDocumentUrl(),
      activeSheet: active.name,
      sheets: usedRanges.map(({ sheet, used }) => ({
        name: sheet.name,
        empty: used.isNullObject,
        usedRange: used.isNullObject ? null : used.address,
        rows: used.isNullObject ? 0 : used.rowCount,
        columns: used.isNullObject ? 0 : used.columnCount,
      })),
    };
  });
}

async function readRange(args: Record<string, unknown>): Promise<unknown> {
  const sheetName = stringArg(args, "sheet");
  const rangeAddress = stringArg(args, "range");
  const includeFormulas = args.include_formulas === true;

  return excelRun(async (context) => {
    const worksheet = await resolveWorksheet(context, sheetName);
    const range = rangeAddress ? worksheet.getRange(rangeAddress) : worksheet.getUsedRangeOrNullObject(true);
    range.load(`address,rowCount,columnCount,values${includeFormulas ? ",formulas" : ""}`);
    await context.sync();
    if (range.isNullObject) {
      return { sheet: worksheet.name, empty: true, values: [] };
    }
    ensureReadableSize(range);
    return {
      sheet: worksheet.name,
      address: range.address,
      rows: range.rowCount,
      columns: range.columnCount,
      values: range.values,
      ...(includeFormulas ? { formulas: range.formulas } : {}),
    };
  });
}

async function readSelection(): Promise<unknown> {
  return excelRun(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load("address,rowCount,columnCount,values");
    await context.sync();
    ensureReadableSize(range);
    return {
      address: range.address,
      rows: range.rowCount,
      columns: range.columnCount,
      values: range.values,
    };
  });
}

function normalizeMatrix(value: unknown): unknown[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("values must be a non-empty 2D array (rows of cells).");
  }
  const rows = value.map((row) => {
    if (!Array.isArray(row) || row.length === 0) {
      throw new Error("values must be a 2D array: every row must be a non-empty array.");
    }
    return row;
  });
  const width = rows[0]!.length;
  if (rows.some((row) => row.length !== width)) {
    throw new Error("values must be rectangular: all rows need the same number of cells.");
  }
  if (rows.length * width > MAX_WRITE_CELLS) {
    throw new Error(`Too many cells (${rows.length * width}); max ${MAX_WRITE_CELLS} per write.`);
  }
  return rows;
}

async function writeCells(args: Record<string, unknown>): Promise<unknown> {
  const sheetName = stringArg(args, "sheet");
  const startCell = stringArg(args, "start_cell");
  if (!startCell) throw new Error("start_cell is required, e.g. \"B2\".");
  const matrix = normalizeMatrix(args.values);
  const asFormulas = args.as_formulas === true;
  const highlight = args.highlight !== false;

  return excelRun(async (context) => {
    const worksheet = await resolveWorksheet(context, sheetName);
    const target = worksheet.getRange(startCell).getResizedRange(matrix.length - 1, matrix[0]!.length - 1);
    if (asFormulas) {
      target.formulas = matrix;
    } else {
      target.values = matrix;
    }
    if (highlight) {
      target.format.fill.color = HIGHLIGHT_COLOR;
    }
    target.load("address");
    await context.sync();
    return {
      applied: true,
      sheet: worksheet.name,
      address: target.address,
      rows: matrix.length,
      columns: matrix[0]!.length,
      highlighted: highlight,
    };
  });
}

async function highlightRange(args: Record<string, unknown>): Promise<unknown> {
  const sheetName = stringArg(args, "sheet");
  const rangeAddress = stringArg(args, "range");
  if (!rangeAddress) throw new Error("range is required, e.g. \"B2:D5\".");
  const color = stringArg(args, "color") ?? HIGHLIGHT_COLOR;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("color must be a hex value like #FFF3BF.");

  return excelRun(async (context) => {
    const worksheet = await resolveWorksheet(context, sheetName);
    const range = worksheet.getRange(rangeAddress);
    range.format.fill.color = color;
    range.load("address");
    await context.sync();
    return { applied: true, sheet: worksheet.name, address: range.address, color };
  });
}

async function addWorksheet(args: Record<string, unknown>): Promise<unknown> {
  const name = stringArg(args, "name");
  if (!name) throw new Error("name is required.");
  return excelRun(async (context) => {
    const sheet = context.workbook.worksheets.add(name);
    sheet.load("name");
    await context.sync();
    return { created: true, sheet: sheet.name };
  });
}

async function search(args: Record<string, unknown>): Promise<unknown> {
  const query = stringArg(args, "query");
  if (!query) throw new Error("query is required.");
  const sheetName = stringArg(args, "sheet");
  const matchCase = args.match_case === true;
  if (!isExcelApiSupported("1.9")) {
    throw new Error("This Excel version does not support workbook search from add-ins (requires ExcelApi 1.9).");
  }

  return excelRun(async (context) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load("items/name");
    await context.sync();

    const targets = sheetName
      ? worksheets.items.filter((sheet) => sheet.name === sheetName)
      : worksheets.items.slice(0, MAX_SEARCH_SHEETS);
    if (sheetName && targets.length === 0) throw new Error(`Worksheet "${sheetName}" not found.`);

    const lookups = targets.map((sheet) => {
      const found = sheet.findAllOrNullObject(query, { completeMatch: false, matchCase });
      found.load("address,areaCount");
      return { sheet, found };
    });
    await context.sync();

    const results = lookups
      .filter(({ found }) => !found.isNullObject)
      .map(({ sheet, found }) => ({
        sheet: sheet.name,
        matches: found.areaCount,
        addresses: found.address,
      }));
    return { query, sheetsSearched: targets.length, results };
  });
}

async function addComment(args: Record<string, unknown>): Promise<unknown> {
  const cell = stringArg(args, "cell");
  const comment = stringArg(args, "comment");
  if (!cell) throw new Error("cell is required, e.g. \"B4\" or \"Sheet1!B4\".");
  if (!comment) throw new Error("comment is required.");
  if (!isExcelApiSupported("1.10")) {
    throw new Error("This Excel version does not support adding comments from add-ins (requires ExcelApi 1.10).");
  }
  const sheetName = stringArg(args, "sheet");

  return excelRun(async (context) => {
    let address = cell;
    if (!cell.includes("!")) {
      const worksheet = await resolveWorksheet(context, sheetName);
      address = `${worksheet.name}!${cell}`;
    }
    context.workbook.comments.add(address, comment);
    await context.sync();
    return { applied: true, cell: address };
  });
}

export function createExcelToolHandlers(): Record<string, WordToolHandler> {
  return {
    excel_read_workbook: readWorkbook,
    excel_read_range: readRange,
    excel_read_selection: readSelection,
    excel_write_cells: writeCells,
    excel_highlight_range: highlightRange,
    excel_add_worksheet: addWorksheet,
    excel_search: search,
    excel_add_comment: addComment,
    excel_run_code: (args) => runOfficeCode("excel", args),
  };
}
