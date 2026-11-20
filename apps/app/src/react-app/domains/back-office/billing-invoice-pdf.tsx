import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "twenty-ui/primitives/input";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { PdfPreview } from "@/react-app/domains/session/artifacts/preview";
import { t } from "@/i18n";

type InvoicePreviewProps = {
  client: Pick<LegalworkServerClient, "downloadTimesheetDraft">;
  scope: string;
  id: string;
  revision: string;
  children: (checked: boolean) => ReactNode;
};

export function saveInvoiceDownload(
  file: {
    data: ArrayBuffer;
    contentType: string | null;
    filename: string | null;
  },
  fallback: string,
) {
  const url = URL.createObjectURL(
    new Blob([file.data], {
      type: file.contentType ?? "application/octet-stream",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename ?? fallback;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Preview = { url: string; filename: string } | { error: string };

export function BillingInvoicePdf({ client, scope, id, revision, children }: InvoicePreviewProps) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ client: InvoicePreviewProps["client"]; preview: Preview }>();
  const preview = result?.client === client ? result.preview : undefined;
  const wordRequest = useRef<AbortController>(undefined);
  const [wordPending, setWordPending] = useState(false);
  const [wordError, setWordError] = useState("");
  const [opened, setOpened] = useState(false);
  const inline = navigator.pdfViewerEnabled !== false;

  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setResult(undefined);
    setWordPending(false);
    setWordError("");
    setOpened(false);
    void client.downloadTimesheetDraft(id, scope, "pdf", { revision, signal: controller.signal }).then((file) => {
      if (controller.signal.aborted) return;
      const signature = new TextDecoder().decode(file.data.slice(0, 5));
      if (file.contentType?.split(";")[0].trim().toLowerCase() !== "application/pdf" || signature !== "%PDF-")
        throw new Error(t("invoiceReview.invalid_preview"));
      url = URL.createObjectURL(new Blob([file.data], { type: "application/pdf" }));
      setResult({ client, preview: { url, filename: file.filename ?? "Invoice-preview.pdf" } });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted)
        setResult({ client, preview: { error: error instanceof Error ? error.message : t("back_office.billing.download_failed") } });
    });
    return () => {
      controller.abort();
      wordRequest.current?.abort();
      wordRequest.current = undefined;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, scope, id, revision, attempt]);

  async function downloadWord() {
    if (wordRequest.current) return;
    const controller = new AbortController();
    wordRequest.current = controller;
    setWordError("");
    setWordPending(true);
    try {
      const file = await client.downloadTimesheetDraft(id, scope, "docx", { revision, signal: controller.signal });
      if (!controller.signal.aborted) saveInvoiceDownload(file, "Invoice-preview.docx");
    } catch (error) {
      if (!controller.signal.aborted)
        setWordError(error instanceof Error ? error.message : t("back_office.billing.download_failed"));
    } finally {
      if (wordRequest.current === controller) {
        wordRequest.current = undefined;
        setWordPending(false);
      }
    }
  }

  const pdf = preview && "url" in preview ? preview : undefined;
  return <>
    {!preview && <p className="bo-billing-subrow" role="status">{t("invoiceReview.loading_pdf")}</p>}
    {preview && "error" in preview && <div className="bo-billing-subrow">
      <p className="bo-billing-error" role="alert">{t("invoiceReview.pdf_error", { message: preview.error })}</p>
      <Button size="sm" variant="outline" onClick={() => { setResult(undefined); setAttempt((previous) => previous + 1); }}>{t("invoiceReview.retry_pdf")}</Button>
    </div>}
    {pdf && <>
      {inline ? <div className="bo-invoice-pdf-frame">
        <PdfPreview url={pdf.url} title={t("invoiceReview.pinned_pdf")} />
      </div> : <p className="bo-billing-subrow" role="status">{t("invoiceReview.pdf_external_help")}</p>}
      <div className="bo-billing-subrow">
        <a className="bo-invoice-link" href={pdf.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
          {t("invoiceReview.preview_pdf")}
        </a>
        <a className="bo-invoice-link" href={pdf.url} download={pdf.filename} onClick={() => setOpened(true)}>
          {t("invoiceReview.download_pdf")}
        </a>
      </div>
    </>}
    <div className="bo-billing-subrow">
      <Button size="sm" variant="ghost" disabled={wordPending} onClick={() => void downloadWord()}>
        {t("invoiceReview.preview_docx")}
      </Button>
      {wordError && <p className="bo-billing-error" role="alert">{wordError}</p>}
    </div>
    {children(Boolean(pdf) && (inline || opened))}
  </>;
}
