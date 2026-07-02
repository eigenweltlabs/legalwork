/**
 * Minimal Excel.js bridge for the task pane, mirroring office.ts: the Excel
 * global from office.js is typed structurally (only the members we use).
 */
import { isOfficeApiSupported, officeHostName } from "./office";

export type ExcelRange = {
  address: string;
  values: unknown[][];
  formulas: unknown[][];
  rowCount: number;
  columnCount: number;
  isNullObject: boolean;
  load: (properties: string) => void;
  getResizedRange: (deltaRows: number, deltaColumns: number) => ExcelRange;
  format: { fill: { color: string } };
};

export type ExcelRangeAreas = {
  address: string;
  areaCount: number;
  isNullObject: boolean;
  load: (properties: string) => void;
};

export type ExcelWorksheet = {
  name: string;
  load: (properties: string) => void;
  getRange: (address: string) => ExcelRange;
  getUsedRangeOrNullObject: (valuesOnly?: boolean) => ExcelRange;
  findAllOrNullObject: (
    text: string,
    criteria: { completeMatch?: boolean; matchCase?: boolean },
  ) => ExcelRangeAreas;
};

export type ExcelWorksheetCollection = {
  items: ExcelWorksheet[];
  load: (properties: string) => void;
  add: (name?: string) => ExcelWorksheet;
  getItem: (name: string) => ExcelWorksheet;
  getActiveWorksheet: () => ExcelWorksheet;
};

export type ExcelWorkbook = {
  worksheets: ExcelWorksheetCollection;
  getSelectedRange: () => ExcelRange;
  comments: { add: (cellAddress: string, content: string) => unknown };
};

export type ExcelRunContext = {
  workbook: ExcelWorkbook;
  sync: () => Promise<void>;
};

type ExcelNamespace = {
  run: <T>(batch: (context: ExcelRunContext) => Promise<T>) => Promise<T>;
};

function excelGlobal(): ExcelNamespace | undefined {
  return (window as unknown as { Excel?: ExcelNamespace }).Excel;
}

/** True when running inside Excel with the Excel JavaScript API available. */
export function isExcelWorkbookHost(): boolean {
  return officeHostName() === "excel" && Boolean(excelGlobal());
}

export function isExcelApiSupported(version: string): boolean {
  return isOfficeApiSupported("ExcelApi", version);
}

/** Run an Excel.run batch. Throws outside of Excel. */
export function excelRun<T>(batch: (context: ExcelRunContext) => Promise<T>): Promise<T> {
  const excel = excelGlobal();
  if (!excel) {
    throw new Error("The Excel JavaScript API is not available in this context.");
  }
  return excel.run(batch);
}
