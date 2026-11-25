import { lazy, Suspense, useContext } from "react";
import { Button } from "@/components/ui/button";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { TimeInvoice } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { InvoiceApprovalPane, type InvoiceWorkspaceActions } from "./invoice-approval-pane";

const DocumentViewer = lazy(() => import("../session/artifacts/artifact-panel").then(module => ({ default: module.ArtifactPanelView })));

export function openInvoiceDocument(
  pane: InvoiceWorkspaceActions,
  client: LegalworkServerClient,
  identity: { scope: string; userId: string },
  document: { id: string; name: string; format: "docx" | "pdf" | "html"; loadFile: () => Promise<{ data: ArrayBuffer; contentType: string | null }> },
) {
  const id = "timekeeping:invoice-document:" + document.id + ":" + document.format;
  const session = ["invoice", identity.scope, identity.userId, document.id, document.format].join(":");
  const name = document.name + "." + document.format;
  pane.openDocument({ id, label: name, content: (
    <Suspense fallback={<p className="p-4 text-sm" role="status">{t("common.loading")}</p>}>
      <DocumentViewer sessionId={session} workspaceId={session} workspaceRoot="" client={client}
        target={{ id, kind: "file", name, value: name, preview: document.format === "docx" ? "word" : document.format,
          exists: true, confidence: 100, reason: t("back_office.invoices.singular") }}
        isRemoteWorkspace localReadOnly loadFile={document.loadFile} onClose={() => pane.closeDocument(id)} />
    </Suspense>
  ) });
}

export function InvoiceDocumentActions({ client, scope, userId, invoice }: {
  client: LegalworkServerClient;
  scope: string;
  userId: string;
  invoice: TimeInvoice;
}) {
  const pane = useContext(InvoiceApprovalPane);
  if (!pane || invoice.recordOnly) return null;
  function open(format: "docx" | "pdf" | "html") {
    if (!pane) return;
    openInvoiceDocument(pane, client, { scope, userId }, {
      id: invoice.id, format, name: t("invoiceReview.document_title", { number: invoice.number }),
      loadFile: () => client.downloadTimesheetInvoice(invoice.id, scope, format),
    });
  }
  if (!invoice.snapshot) return <Button size="xs" variant="ghost" onClick={() => open("html")}>{t("invoiceReview.open_invoice")}</Button>;
  return <div className="flex items-center gap-1">
    <Button size="xs" variant="ghost" onClick={() => open("docx")} aria-label={t("invoiceReview.open_word")}>Word</Button>
    <Button size="xs" variant="ghost" onClick={() => open("pdf")} aria-label={t("invoiceReview.preview_pdf")}>PDF</Button>
  </div>;
}
