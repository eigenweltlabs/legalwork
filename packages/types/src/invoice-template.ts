import { z } from "zod";
export const invoiceTemplateSchema = z.strictObject({
  word: z.strictObject({
    name: z.string().trim().min(1).max(180).regex(/\.docx$/i),
    contentBase64: z.string().min(4).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }).optional(),
  revision: z.number().int().nonnegative(),
  locale: z.enum(["de-AT", "en-GB"]),
  title: z.string().trim().min(1).max(100),
  letterhead: z.string().trim().max(1800),
  footer: z.string().trim().max(3000),
});
export type InvoiceTemplate = z.infer<typeof invoiceTemplateSchema>;
// A starter Word document with an editable two-column service table.
export const starterInvoiceWord = "UEsDBBQAAAAIAK+cdF33S4B1wgAAAHYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QuQ7CMAyGX6XKiqgRAwOiLMAKDLyAlbptRC7FLsfbk3INCBjt//gsLw7XSFxcnPVcqU4kzgFYd+SQyxDJZ6UJyaHkMbUQUR+xJZhOJjPQwQt5GcvQoZaLNTXYWyk2l7xmE3ylEllWxephHFiVwhit0ShZh5OvPyjjJ6HMybuHOxN5lA0KvhIG5TfgmdudKCVTU7HHJFt02QXnkGqog+5dTpb/a77cGZrGaHrnh7aYgiZm41tny7fi0PjX/XB/9/IGUEsDBBQAAAAIAK+cdF1hey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQUAAAACACvnHRdaLSKrqMBAACdBQAAEQAAAHdvcmQvZG9jdW1lbnQueG1srZTNTiMxDIBfJRqpVzIFVMGo9LKHPSEh7YFjlUncmUj5U+IysKjvjjNhKCCqdrW9xI6TfI4dO8uhUV5uLThkz9a41Ax3VY8YGs6T7MGKdOEDOFrb+GgF0jR2fPBRheglpKRdZw2/rOsFt0K7arUcmtarlyxDHmIeRnqTgpBwV4UICeITVKvXV2YAEWIPQrHdbslp6yqPcRzDV0p8GEXLy5aHI2jUaICojHTtnryWsHZb20I87uowdSIpgfA/HGk0ZX3thD0HRihF1nSIhK15F+9Ja80jG/Jj39Z1XZGKL4HQ6llUJbuft/6OWmW1I/nLm3JwQSfz3m/my3kx8y8nsaDkqVEpSDLqgNq7tREtmJ8D4xPzdLKwfkv5Og7lH7f+p7vPGDUKM9oBVcooE5vtcqGTevEpLnI+WXu/jenMcY7gEmz2NGPgVL7Z7PwhU6d5FObMAYzMU16If5T3KdiN93j4A0ggsZR96P78LRU9n9/Wi9wiPemLm6ubUvWhuxcxN44PZL++Hrso6q7H/bT1iN7u5wY202ppkckfnz5Nvv+QV29QSwECFAMUAAAACACvnHRd90uAdcIAAAB2AQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAK+cdF1hey9DiQAAAPIAAAALAAAAAAAAAAAAAACAAfMAAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAK+cdF1otIquowEAAJ0FAAARAAAAAAAAAAAAAACAAaUBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAB3AwAAAAA=";
export const standardInvoice: InvoiceTemplate = {
  revision: 0,
  locale: "en-GB",
  title: "Invoice",
  letterhead: "",
  footer: "",
};
export const invoiceBillingModeSchema = z.enum(["hourly", "fixed"]);
export const invoiceAmountSchema = z.number().int().nonnegative().safe();
type InvoiceRow = {
  date: string;
  narrative: string;
  billableMinutes: number;
  workedMinutes?: number;
  hourlyRate?: number;
  amountMinor?: number;
};
type InvoiceFields = {
  number?: number;
  date: string;
  client: string;
  clientAddress?: string;
  currency: string;
  billingMode?: z.infer<typeof invoiceBillingModeSchema>;
  showHours?: boolean;
  entries: InvoiceRow[];
};

/** Allocate integer currency units by descending fractional remainder, then stable entry ID. */
export function allocateInvoiceMinor(target: number, weights: { id: string; weight: number }[]) {
  const total = weights.reduce((sum, row) => sum + BigInt(row.weight), BigInt(0));
  if (target === 0) return new Map(weights.map(({ id }) => [id, 0]));
  if (total === BigInt(0)) throw new Error("A positive target needs at least one positive line.");
  const allocations = weights.map(({ id, weight }) => {
    const share = BigInt(target) * BigInt(weight);
    return { id, amount: Number(share / total), remainder: share % total };
  });
  const remainder = target - allocations.reduce((sum, row) => sum + row.amount, 0);
  allocations.sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.id < b.id ? -1 : Number(a.id !== b.id);
  });
  return new Map(allocations.map(({ id, amount }, index) => [id, amount + Number(index < remainder)]));
}

/** A basis point is one hundredth of a percentage point. */
export function reducedInvoiceMinor(amount: number, basisPoints: number) {
  return Number((BigInt(amount) * BigInt(10_000 - basisPoints) + BigInt(5_000)) / BigInt(10_000));
}

export function currencyScale(currency: string) {
  return (
    10 **
    (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2)
  );
}

export function formatInvoiceMinor(locale: string, currency: string, minor: number) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = money.resolvedOptions().maximumFractionDigits ?? 2;
  const scale = BigInt(10) ** BigInt(digits);
  const value = BigInt(minor);
  const whole = value / scale;
  if (!digits) return money.format(whole);
  const fraction = (value < BigInt(0) ? -value : value) % scale;
  const decimals = new Intl.NumberFormat(locale, { useGrouping: false, minimumIntegerDigits: digits });
  return money.formatToParts(value < BigInt(0) && whole === BigInt(0) ? -0 : whole)
    .map(({ type, value }) => type === "fraction" ? decimals.format(fraction) : value).join("");
}

export function formatInvoiceHours(locale: string, minutes: number) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(minutes / 60);
}

/** Round each decimal hourly rate once, at the currency's minor unit. */
export function timeFeeMinor(minutes: number, hourlyRate: number, scale: number) {
  const [decimal, power = "0"] = hourlyRate.toString().split("e");
  const [whole, fraction = ""] = decimal.split(".");
  const exponent = Number(power) - fraction.length;
  const numerator =
    BigInt(whole + fraction) * BigInt(minutes) * BigInt(scale) * BigInt(10) ** BigInt(Math.max(0, exponent));
  const denominator = BigInt(60) * BigInt(10) ** BigInt(Math.max(0, -exponent));
  return Number((numerator + denominator / BigInt(2)) / denominator);
}

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function renderInvoice(
  template: InvoiceTemplate,
  { number, date, client, clientAddress, currency, entries, billingMode, showHours }: InvoiceFields,
) {
  const de = template.locale === "de-AT";
  const scale = currencyScale(currency);
  const amount = (r: InvoiceRow) =>
    r.amountMinor ?? timeFeeMinor(r.billableMinutes, r.hourlyRate ?? 0, scale);
  const heading = escape(template.title) + (number === undefined ? "" : " " + number);
  const actualHours = showHours !== false && billingMode !== undefined;
  const chargeableHours = billingMode === "hourly";
  const showMinutes = billingMode === undefined;
  const columns = 2 + Number(actualHours) + Number(chargeableHours) + Number(showMinutes);
  const rows = entries
    .map(
      (r) =>
        "<tr><td>" +
        escape(r.date) +
        "</td><td>" +
        escape(r.narrative) +
        "</td>" +
        (showMinutes ? "<td>" + r.billableMinutes + "</td>" : "") +
        (actualHours ? "<td>" + formatInvoiceHours(template.locale, r.workedMinutes ?? 0) + "</td>" : "") +
        (chargeableHours ? "<td>" + formatInvoiceHours(template.locale, r.billableMinutes) + "</td>" : "") +
        "<td>" +
        escape(formatInvoiceMinor(template.locale, currency, amount(r))) +
        "</td></tr>",
    )
    .join("");
  return (
    '<!doctype html><html lang="' +
    (de ? "de" : "en") +
    '"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;"><title>' +
    heading +
    "</title><style>body{font:14px/1.5 system-ui;margin:2rem;color:#212821}h1{font-size:1.7rem}header,footer,p{white-space:pre-line}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border-bottom:1px solid #ddd;text-align:left;padding:6px}td:nth-child(n+3),th:nth-child(n+3){text-align:right}footer{margin-top:2rem}@media print{body{margin:0}}</style><header>" +
    escape(template.letterhead) +
    "</header><h1>" +
    heading +
    "</h1><p>" +
    escape(client) +
    (clientAddress ? "<br>" + escape(clientAddress) : "") +
    "<br>" +
    escape(date) +
    "</p><table><thead><tr><th>" +
    (de ? "Datum" : "Date") +
    "</th><th>" +
    (de ? "Leistung" : "Description") +
    "</th>" +
    (showMinutes ? "<th>Min.</th>" : "") +
    (actualHours ? "<th>" + (de ? "Iststunden" : "Actual hours") + "</th>" : "") +
    (chargeableHours ? "<th>" + (de ? "Verrechenbare Stunden" : "Chargeable hours") + "</th>" : "") +
    "<th>" +
    (de ? "Honorar" : "Fee") +
    "</th></tr></thead><tbody>" +
    rows +
    '</tbody><tfoot><tr><th colspan="' + columns + '">' +
    (de ? "Summe" : "Total") +
    "</th><th>" +
    escape(formatInvoiceMinor(template.locale, currency, entries.reduce((sum, r) => sum + amount(r), 0))) +
    "</th></tr></tfoot></table><footer>" +
    escape(template.footer) +
    "</footer></html>"
  );
}
