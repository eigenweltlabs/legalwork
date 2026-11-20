import type { TimeInvoice, TimeInvoiceDraft } from "./timesheet-schema.js";
import type { BackOfficeStore } from "./store.js";
import { timeError } from "./timesheet-data.js";
import {
  renderWordInvoice,
  convertInvoicePdf,
  invoiceWordMime,
  type InvoiceOutput,
} from "./invoice-word.js";

export function draftOutput(draft: TimeInvoiceDraft): InvoiceOutput {
  return {
    ...draft.snapshot,
    currency: draft.currency,
    totalMinor: draft.totalMinor,
    hourly: draft.input.pricing.mode === "hourly",
    showHours: draft.showHours,
    lines: draft.lines.map((row) => ({
      ...row.entry,
      amountMinor: row.amountMinor,
    })),
  };
}
export function issuedOutput(invoice: TimeInvoice): InvoiceOutput {
  if (
    !invoice.snapshot ||
    !invoice.approval ||
    invoice.totalMinor === undefined
  )
    timeError("This historical invoice has only an HTML document.", 404);
  return {
    ...invoice.snapshot,
    number: invoice.number,
    currency: invoice.currency,
    totalMinor: invoice.totalMinor,
    hourly: invoice.billingMode === "hourly",
    showHours: invoice.showHours === true,
    lines: invoice.entries.map((row) => ({
      ...row,
      amountMinor: row.amountMinor!,
    })),
  };
}
/** A single insert publishes the pair. Concurrent converters return the bytes chosen by the first insert. */
export async function issuedArtifacts(
  store: BackOfficeStore,
  scope: string,
  invoice: TimeInvoice,
) {
  const input = issuedOutput(invoice);
  const get = () =>
    store.db.get(
      "SELECT revision,docx,pdf FROM bo_invoice_files WHERE scope=? AND id=?",
      [scope, invoice.id],
    );
  let row = get();
  if (!row) {
    const word = renderWordInvoice(input);
    const pdf = await convertInvoicePdf(word);
    store.db.run(
      "INSERT OR IGNORE INTO bo_invoice_files(scope,id,revision,docx,pdf) VALUES(?,?,?,?,?)",
      [
        scope,
        invoice.id,
        invoice.approval!.revision,
        word.toString("base64"),
        pdf.toString("base64"),
      ],
    );
    row = get();
  }
  if (!row || row.revision !== invoice.approval!.revision)
    timeError("The issued files do not match the approved revision.", 409);
  return {
    docx: Buffer.from(String(row.docx), "base64"),
    pdf: Buffer.from(String(row.pdf), "base64"),
  };
}
export function invoiceAttachment(
  format: "docx" | "pdf",
  data: Buffer,
  label: string,
) {
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": format === "pdf" ? "application/pdf" : invoiceWordMime,
      "content-disposition":
        'attachment; filename="Invoice-' + label + "." + format + '"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
