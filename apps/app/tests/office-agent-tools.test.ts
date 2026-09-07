import { describe, expect, test } from "bun:test";
import { officeRange, xlsxWriteSchema } from "@legalwork/types/office-editor";
import { replaceTextSegments } from "../src/react-app/domains/session/artifacts/office-agent-text";

describe("Office agent edit validation", () => {
  test("bounds ranges before allocating cell matrices", () => {
    expect(officeRange("B4:D5")).toEqual({ startRow: 3, endRow: 4, startColumn: 1, endColumn: 3 });
    for (const value of ["A:A", "A0", "B3:A1", "A1:ZZ99999", "A1:A100001", "Sheet1!A1", "A1:B0"]) expect(() => officeRange(value)).toThrow();
    expect(xlsxWriteSchema.safeParse({ path: "budget.xlsx", sheet: "Budget", range: "A1", values: [[Infinity]] }).success).toBe(false);
  });
  test("replaces across styled text runs while keeping untouched styling", () => {
    const runs = [{ text: "The draft ", bold: true }, { text: "budget", bold: false }, { text: " is ready.", bold: true }];
    expect(replaceTextSegments(runs, "The draft budget is ready.", "draft budget", "approved estimate")).toEqual([
      { text: "The approved estimate", bold: true }, { text: "", bold: false }, { text: " is ready.", bold: true },
    ]);
    expect(runs[0]?.text).toBe("The draft ");
  });
  test("rejects stale, ambiguous and complex paragraph edits", () => {
    expect(() => replaceTextSegments([{ text: "draft draft" }], "draft draft", "draft", "final")).toThrow();
    expect(() => replaceTextSegments([{ text: "draft" }], "draft", "old", "final")).toThrow();
    expect(() => replaceTextSegments([{ text: "ab" }], "a\nb", "a", "c")).toThrow();
  });
  test("keeps literal replacement tokens as text", () => {
    expect(replaceTextSegments([{ text: "draft" }], "draft", "draft", "$&")[0]?.text).toBe("$&");
  });
});
