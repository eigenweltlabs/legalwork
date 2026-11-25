import { expect, test } from "bun:test";
import { backOfficeMoneyFromMajor, sumBackOfficeMoney } from "@legalwork/types/back-office";
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

test("currency input keeps explicit precision and existing cent-scaled values", () => {
  const legacyKwd = { currency: "KWD", amountMinor: 1235 };
  const legacyJpy = { currency: "JPY", amountMinor: 735 };
  const invoiceKwd = { currency: "KWD", amountMinor: 1235, exactAmount: { amountMinor: 12345, minorUnitScale: 1000 } };
  expect(cellInputText(legacyKwd)).toBe("12.35");
  expect(cellInputText(legacyJpy)).toBe("7.35");
  expect(cellInputText(invoiceKwd)).toBe("12.345");
  expect(cellInputText({ currency: "JPY", amountMinor: 400 })).toBe("4");
  expect(parseCellInput("currency", "12.35", legacyKwd)).toEqual(legacyKwd);
  expect(parseCellInput("currency", "7.35", legacyJpy)).toEqual(legacyJpy);
  expect(parseCellInput("currency", "12.345", legacyKwd)).toEqual(invoiceKwd);
});

test("table totals sum in integer units across exact and legacy amounts", () => {
  expect(sumBackOfficeMoney(Array.from({ length: 10 }, () => ({ currency: "JPY", amountMinor: 5 })))).toBe(0.5);
  expect(sumBackOfficeMoney([{ currency: "KWD", amountMinor: 1235 }, backOfficeMoneyFromMajor(12.345, "KWD")])).toBe(24.695);
});
