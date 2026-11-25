import { useEffect, useState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { PdfPreview } from "@/react-app/domains/session/artifacts/preview";
import { t } from "@/i18n";

type InvoicePreviewProps = {
  client: Pick<LegalworkServerClient, "downloadTimesheetDraft">;
  scope: string;
  id: string;
  revision: string;
  openWord?: () => void;
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

export function BillingInvoicePdf({ client, scope, id, revision, openWord, children }: InvoicePreviewProps) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ client: InvoicePreviewProps["client"]; preview: Preview }>();
  const preview = result?.client === client ? result.preview : undefined;
  const [opened, setOpened] = useState(false);
  const inline = navigator.pdfViewerEnabled !== false;

  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setResult(undefined);
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
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, scope, id, revision, attempt]);

  const pdf = preview && "url" in preview ? preview : undefined;
  return <>
    <div className="bo-invoice-preview-tools">
      {pdf && <>
        <a className={buttonVariants({ size: "xs", variant: "ghost" })} href={pdf.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
          <ExternalLink />{t("invoiceReview.preview_pdf")}
        </a>
        <a className={buttonVariants({ size: "xs", variant: "ghost" })} href={pdf.url} download={pdf.filename} onClick={() => setOpened(true)}>
          <Download />{t("invoiceReview.download_pdf")}
        </a>
      </>}
      {openWord && <Button size="xs" variant="ghost" onClick={openWord}>
        <FileText />{t("invoiceReview.open_word")}
      </Button>}
    </div>
    <div className="bo-invoice-preview-body">
      {!preview && <p className="bo-invoice-preview-status" role="status"><Loader2 size={16} className="animate-spin" />{t("invoiceReview.loading_pdf")}</p>}
      {preview && "error" in preview && <div className="bo-invoice-preview-status">
        <p className="bo-billing-error" role="alert">{t("invoiceReview.pdf_error", { message: preview.error })}</p>
        <Button size="sm" variant="outline" onClick={() => { setResult(undefined); setAttempt(previous => previous + 1); }}>{t("invoiceReview.retry_pdf")}</Button>
      </div>}
      {pdf && (inline ? <div className="bo-invoice-pdf-frame">
        <PdfPreview url={pdf.url + "#toolbar=0&view=FitH"} title={t("invoiceReview.pinned_pdf")} />
      </div> : <p className="bo-invoice-preview-status" role="status">{t("invoiceReview.pdf_external_help")}</p>)}
    </div>
    {children(Boolean(pdf) && (inline || opened))}
  </>;
}
