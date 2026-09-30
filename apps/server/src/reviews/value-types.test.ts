import { expect, test } from "bun:test";
import { ReviewColumnSchema, ReviewColumnKindSchema, type ReviewColumn } from "./schema.js";
import { validateColumnValue } from "./value-types.js";
import { columnBackend } from "./policy.js";
const column = (kind: ReviewColumn["kind"]) => ReviewColumnSchema.parse({ key: "value", label: "Value", question: "What is the value?", kind, options: kind === "multi_select" || kind === "classification" ? ["A", "B"] : [] });
test("all extraction types use LLM in mixed mode and are forbidden in Only JEV", () => {
  for (const kind of ReviewColumnKindSchema.options.filter(kind => !["yes_no", "classification"].includes(kind))) {
    expect(columnBackend("mixed", column(kind))).toBe("llm"); expect(() => columnBackend("jev", column(kind))).toThrow("Only JEV");
  }
});
test("dates must be exact valid calendar dates", () => {
  expect(() => validateColumnValue(column("date"), "2028-02-29")).not.toThrow();
  for (const value of ["2026-02-29", "2026-13-01", "2026-04-31", "25/09/2026", "2026"]) expect(() => validateColumnValue(column("date"), value)).toThrow();
});
test("numbers and percentages reject ambiguous separators and nonfinite values", () => {
  for (const kind of ["number", "percentage"] satisfies ReviewColumn["kind"][]) {
    for (const value of ["0", "-12.5", "1234567.89"]) expect(() => validateColumnValue(column(kind), value)).not.toThrow();
    for (const value of ["12%", "1,234", "NaN", "Infinity", "EUR 50"]) expect(() => validateColumnValue(column(kind), value)).toThrow();
  }
});
test("money requires an amount and currency; multi-select uses distinct fixed options", () => {
  expect(() => validateColumnValue(column("currency"), '{"amount":1500.25,"currency":"EUR"}')).not.toThrow();
  for (const value of ['{"amount":1500}', '{"amount":"1500","currency":"EUR"}', '{"amount":1500,"currency":"€"}']) expect(() => validateColumnValue(column("currency"), value)).toThrow();
  expect(() => validateColumnValue(column("multi_select"), '["A","B"]')).not.toThrow();
  for (const value of ['["C"]', '["A","A"]', '[]', 'A']) expect(() => validateColumnValue(column("multi_select"), value)).toThrow();
});
test("absent or uncertain evidence is never coerced to zero or a date", () => {
  for (const kind of ReviewColumnKindSchema.options) for (const value of ["Not found", "Needs review"]) expect(() => validateColumnValue(column(kind), value)).not.toThrow();
});
