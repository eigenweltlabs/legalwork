/** @jsxImportSource react */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { createPreviewPdfBridge, offlinePreviewDocument } from "./html-preview-security";
import { AlertCircle, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { DocumentIcon } from "@/react-app/design-system/document-icon";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";
import { MarkdownBlock } from "../surface/markdown";
import { t } from "@/i18n";

interface PreviewLoadingProps extends React.ComponentProps<"div"> {}

export function PreviewLoading({ className, ...props }: PreviewLoadingProps) {
  return (
    <div role="status" className={cn("flex h-full flex-col items-center justify-center gap-3 text-muted-foreground", className)} {...props}>
      <Loader2 aria-hidden="true" className="size-5 animate-spin" strokeWidth={1.5} />
      <p className="text-xs">{t("artifact.opening_preview")}</p>
    </div>
  );
}

interface PreviewErrorProps extends React.ComponentProps<"div"> {
  message: string;
}

export function PreviewError({ message, className, ...props }: PreviewErrorProps) {
  return (
    <div role="alert" className={cn("h-full overflow-auto", className)} {...props}>
      <PanelEmptyState icon={<AlertCircle />} title={t("artifact.preview_unable_title")} description={message} />
    </div>
  );
}

interface PlainTextProps extends React.ComponentProps<"pre"> {
  content: string;
}

export function PlainText({ content, className, ...props }: PlainTextProps) {
  return <pre className={cn("h-full overflow-auto p-4 text-xs leading-5 text-foreground whitespace-pre-wrap", className)} {...props}>{content}</pre>;
}

interface MarkdownPreviewProps extends React.ComponentProps<"div"> {
  content: string;
}

export function MarkdownPreview({ content, className, ...props }: MarkdownPreviewProps) {
  return (
    <div className={cn("h-full overflow-auto p-4", className)} {...props}>
      <MarkdownBlock text={content} />
    </div>
  );
}

interface TextHTMLPreviewProps {
  type: "text";
  title: string;
  content: string;
  readPdf?: (path: string) => Promise<{ data: ArrayBuffer; contentType?: string | null }>;
}

interface BinaryHTMLPreviewProps {
  type: "binary";
  title: string;
  url: string;
}

type HTMLPreviewProps = { className?: string } & (TextHTMLPreviewProps | BinaryHTMLPreviewProps);

export function HTMLPreview({ className, ...props }: HTMLPreviewProps) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const pending = React.useRef(new Map<string, (allowed: boolean) => void>());
  const [requests, setRequests] = React.useState<string[]>([]);
  const [binaryContent, setBinaryContent] = React.useState<string | null>(null);
  const readPdf = props.type === "text" ? props.readPdf : undefined;
  const readPdfRef = React.useRef(readPdf);
  readPdfRef.current = readPdf;
  const content = props.type === "text" ? props.content : binaryContent;
  const binaryUrl = props.type === "binary" ? props.url : null;
  React.useEffect(() => {
    if (!binaryUrl) return;
    const controller = new AbortController();
    setBinaryContent(null);
    void fetch(binaryUrl, { signal: controller.signal }).then((response) => response.text()).then(setBinaryContent).catch(() => {});
    return () => controller.abort();
  }, [binaryUrl]);
  React.useEffect(() => {
    if (!readPdfRef.current || content === null) return;
    const bridge = createPreviewPdfBridge({
      getFrame: () => frame.current?.contentWindow ?? null,
      requestAccess: (path) => new Promise<boolean>((resolve) => {
        pending.current.set(path, resolve);
        setRequests([...pending.current.keys()]);
      }),
      readPdf: (path) => {
        const read = readPdfRef.current;
        if (!read) throw new Error("Source PDF access is unavailable.");
        return read(path);
      },
    });
    const onMessage = (event: MessageEvent) => { void bridge.onMessage(event); };
    window.addEventListener("message", onMessage);
    return () => {
      bridge.dispose();
      window.removeEventListener("message", onMessage);
      for (const resolve of pending.current.values()) resolve(false);
      pending.current.clear();
      setRequests([]);
    };
  }, [content]);
  const respond = (path: string, allowed: boolean) => {
    pending.current.get(path)?.(allowed);
    pending.current.delete(path);
    setRequests([...pending.current.keys()]);
  };
  if (content === null) return <PreviewLoading />;
  return <div className={cn("flex h-full min-h-0 flex-col", className)}>
    {requests[0] ? <div className="shrink-0 border-b border-border bg-muted px-4 py-3 text-sm" role="alert">
      <p>{t("artifact.preview_pdf_access")}</p>
      <p className="my-2 break-all font-mono text-xs">{requests[0]}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => respond(requests[0]!, true)}>{t("artifact.preview_pdf_allow")}</Button>
        <Button size="sm" variant="outline" onClick={() => respond(requests[0]!, false)}>{t("artifact.preview_pdf_deny")}</Button>
      </div>
    </div> : null}
    <iframe ref={frame} srcDoc={offlinePreviewDocument(content)} title={props.title} className="min-h-0 w-full flex-1 border-0" sandbox="allow-scripts" />
  </div>;
}

interface PdfPreviewProps {
  url: string;
  title: string;
  className?: string;
}

/**
 * PDFs render through the browser/Chromium built-in PDF viewer (PDFium). That
 * viewer is a plugin, so unlike HTMLPreview this iframe must NOT be sandboxed —
 * the `sandbox` attribute disables plugins and leaves the frame blank. In
 * Electron the main window must also enable `plugins`. The bytes are the user's
 * own workspace file served from a same-origin blob URL, and PDFium sandboxes
 * any script embedded in the PDF itself.
 */
export function PdfPreview({ url, title, className }: PdfPreviewProps) {
  return <iframe src={url} title={title} className={cn("h-full w-full border-0", className)} />;
}

interface ImagePreviewProps extends React.ComponentProps<"div"> {
  src: string;
  alt: string;
  regions?: Array<{ x: number; y: number; width: number; height: number }>;
}

export function ImagePreview({ src, alt, regions, className, ...props }: ImagePreviewProps) {
  if (regions) return <div className={cn("min-h-0 flex-1 overflow-auto bg-muted/30 p-3", className)} {...props}>
    <div className="relative mx-auto w-full"><img src={src} alt={alt} className="block h-auto w-full" />{regions.map((region, index) => <div key={index} className="pointer-events-none absolute border border-warning/80 bg-warning/20" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />)}</div>
  </div>;
  return (
    <div className={cn("flex h-full items-center justify-center overflow-auto bg-muted/30 p-3", className)} {...props}>
      <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

interface PreviewUnavailableProps extends React.ComponentProps<"div"> {}

export function PreviewUnavailable({ className, ...props }: PreviewUnavailableProps) {
  return (
    <div className={cn("h-full overflow-auto", className)} {...props}>
      <PanelEmptyState icon={<DocumentIcon kind="unknown" />} title={t("artifact.preview_unavailable_title")} description={t("artifact.preview_unavailable_desc")} />
    </div>
  );
}
