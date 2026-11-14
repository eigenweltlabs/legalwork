import { z } from "zod";
export const invoiceTemplateSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  locale: z.enum(["de-AT", "en-GB"]),
  title: z.string().trim().min(1).max(100),
  letterhead: z.string().trim().max(1800),
  footer: z.string().trim().max(3000),
});
export type InvoiceTemplate = z.infer<typeof invoiceTemplateSchema>;
export const standardInvoice: InvoiceTemplate = {
  revision: 0,
  locale: "en-GB",
  title: "Invoice",
  letterhead: "",
  footer: "",
};
type InvoiceRow = {
  date: string;
  narrative: string;
  billableMinutes: number;
  hourlyRate?: number;
  amountMinor?: number;
};
type InvoiceFields = {
  number?: number;
  date: string;
  client: string;
  currency: string;
  entries: InvoiceRow[];
};

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
  { number, date, client, currency, entries }: InvoiceFields,
) {
  const de = template.locale === "de-AT",
    money = new Intl.NumberFormat(template.locale, {
      style: "currency",
      currency,
    });
  const scale = 10 ** (money.resolvedOptions().maximumFractionDigits ?? 2);
  const amount = (r: InvoiceRow) =>
    r.amountMinor ?? Math.round((r.billableMinutes * (r.hourlyRate ?? 0) * scale) / 60);
  const heading = escape(template.title) + (number === undefined ? "" : " " + number);
  const rows = entries
    .map(
      (r) =>
        "<tr><td>" +
        escape(r.date) +
        "</td><td>" +
        escape(r.narrative) +
        "</td><td>" +
        r.billableMinutes +
        "</td><td>" +
        escape(money.format(amount(r) / scale)) +
        "</td></tr>",
    )
    .join("");
  return (
    '<!doctype html><html lang="' +
    (de ? "de" : "en") +
    '"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;"><title>' +
    heading +
    "</title><style>body{font:14px/1.5 system-ui;margin:2rem;color:#212821}h1{font-size:1.7rem}header,footer{white-space:pre-line}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border-bottom:1px solid #ddd;text-align:left;padding:6px}td:nth-last-child(-n+2),th:nth-last-child(-n+2){text-align:right}footer{margin-top:2rem}@media print{body{margin:0}}</style><header>" +
    escape(template.letterhead) +
    "</header><h1>" +
    heading +
    "</h1><p>" +
    escape(client) +
    "<br>" +
    escape(date) +
    "</p><table><thead><tr><th>" +
    (de ? "Datum" : "Date") +
    "</th><th>" +
    (de ? "Leistung" : "Description") +
    "</th><th>Min.</th><th>" +
    (de ? "Honorar" : "Fee") +
    "</th></tr></thead><tbody>" +
    rows +
    '</tbody><tfoot><tr><th colspan="3">' +
    (de ? "Summe" : "Total") +
    "</th><th>" +
    escape(money.format(entries.reduce((sum, r) => sum + amount(r), 0) / scale)) +
    "</th></tr></tfoot></table><footer>" +
    escape(template.footer) +
    "</footer></html>"
  );
}
