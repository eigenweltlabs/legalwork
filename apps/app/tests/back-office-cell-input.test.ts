import { expect, test } from "bun:test";
import { cellInputText, parseCellInput } from "../src/react-app/domains/back-office/cell-input";

test("currency edits round-trip minor units, preserve the currency and distinguish zero from clearing", () => {
  const current = { currency: "USD", amountMinor: 1205 };
  expect(parseCellInput("currency", cellInputText(current), current)).toEqual(current);
  expect(parseCellInput("currency", "0", undefined)).toEqual({ currency: "EUR", amountMinor: 0 });
  expect(parseCellInput("currency", "", current)).toBeNull();
  expect(() => parseCellInput("number", "NaN", undefined)).toThrow("Enter a number.");
});

test("plain text, boolean and free-form multi-select edits keep their field types", () => {
  expect(parseCellInput("text", "0010", undefined)).toBe("0010");
  expect(parseCellInput("boolean", "false", true)).toBe(false);
  expect(parseCellInput("multiselect", "one, , two", undefined)).toEqual(["one", "two"]);
  expect(cellInputText(["one", "two"])).toBe("one, two");
});
