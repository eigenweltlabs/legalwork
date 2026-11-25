import { expect, test } from "bun:test";
import {
  currencyScale,
  formatInvoiceMinor,
  timeFeeMinor,
  renderInvoice,
  standardInvoice,
} from "@legalwork/types/invoice-template";
test("preview and issued client-facing document share template, rounding and escaped content", () => {
  const template = {
    ...standardInvoice,
    title: "Rechnung",
    locale: "de-AT" as const,
    letterhead: "A & B",
    footer: "Frist 14 Tage.",
  };
  const fields = {
    date: "2026-11-12",
    client: "Firma A",
    currency: "EUR",
    entries: [{ date: "2026-11-11", narrative: "<draft>", billableMinutes: 10, hourlyRate: 100 }],
  };
  const preview = renderInvoice(template, fields),
    issued = renderInvoice(template, { ...fields, number: 1043 });
  expect(issued.replaceAll("Rechnung 1043", "Rechnung")).toBe(preview);
  for (const text of ["16,67", "Frist 14 Tage.", "A &amp; B", "&lt;draft&gt;", "Firma A"])
    expect(issued).toContain(text);
});

test("fees round decimal ties once in the issuing currency", () => {
  expect(timeFeeMinor(60, 1.005, currencyScale("EUR"))).toBe(101);
  expect(timeFeeMinor(30, 7, currencyScale("JPY"))).toBe(4);
  expect(timeFeeMinor(15, 1.234, currencyScale("KWD"))).toBe(309);
  expect(timeFeeMinor(60, 1e-7, currencyScale("EUR"))).toBe(0);
});

test("formatting preserves exact minor amounts and suppresses rounding drift in large invoices", () => {
  expect(formatInvoiceMinor("en-GB", "EUR", Number.MAX_SAFE_INTEGER)).toBe("€90,071,992,547,409.91");
  expect(formatInvoiceMinor("en-GB", "EUR", -1)).toBe("-€0.01");
  expect(formatInvoiceMinor("en-GB", "JPY", 42)).toBe(new Intl.NumberFormat("en-GB", { style: "currency", currency: "JPY" }).format(42));
  expect(formatInvoiceMinor("en-GB", "KWD", 12345)).toMatch(/12\.345/);
});
