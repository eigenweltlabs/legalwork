/** @jsxImportSource react */
import type * as React from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { DocumentIcon } from "@/react-app/design-system/document-icon";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";
import { MarkdownBlock } from "../surface/markdown";

interface PreviewLoadingProps extends React.ComponentProps<"div"> {}

export function PreviewLoading({ className, ...props }: PreviewLoadingProps) {
  return (
    <div role="status" className={cn("flex h-full flex-col items-center justify-center gap-3 text-muted-foreground", className)} {...props}>
      <Loader2 aria-hidden="true" className="size-5 animate-spin" strokeWidth={1.5} />
      <p className="text-xs">Opening preview…</p>
    </div>
  );
}

interface PreviewErrorProps extends React.ComponentProps<"div"> {
  message: string;
}

export function PreviewError({ message, className, ...props }: PreviewErrorProps) {
  return (
    <div role="alert" className={cn("h-full overflow-auto", className)} {...props}>
      <PanelEmptyState icon={<AlertCircle />} title="Unable to open this preview" description={message} />
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
}

interface BinaryHTMLPreviewProps {
  type: "binary";
  title: string;
  url: string;
}

type HTMLPreviewProps = { className?: string } & (TextHTMLPreviewProps | BinaryHTMLPreviewProps);

export function HTMLPreview({ className, ...props }: HTMLPreviewProps) {
  if (props.type === "text") {
    return <iframe srcDoc={props.content} title={props.title} className={cn("h-full w-full border-0", className)} sandbox="allow-scripts allow-same-origin" />;
  }

  return <iframe src={props.url} title={props.title} className={cn("h-full w-full border-0", className)} sandbox="allow-scripts allow-same-origin" />;
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
}

export function ImagePreview({ src, alt, className, ...props }: ImagePreviewProps) {
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
      <PanelEmptyState icon={<DocumentIcon kind="unknown" />} title="Preview unavailable" description="Open this file in its own app to view its contents." />
    </div>
  );
}
