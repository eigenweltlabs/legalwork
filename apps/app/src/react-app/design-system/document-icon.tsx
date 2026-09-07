import { useId, type ComponentProps } from "react";
import { Globe } from "lucide-react";

import { cn } from "@/lib/utils";

export type DocumentIconKind = "browser" | "markdown" | "sheet" | "slides" | "word" | "image" | "video" | "audio" | "pdf" | "html" | "text" | "external" | "unknown";

type DocumentIconProps = Omit<ComponentProps<"svg">, "children"> & {
  kind: DocumentIconKind;
};

/** One asset family for attachments, preview tabs, and file browsers. */
export function DocumentIcon({ kind, className, ...props }: DocumentIconProps) {
  const id = useId();
  if (kind === "browser") {
    return <Globe aria-hidden="true" strokeWidth={1.5} className={cn("size-5 shrink-0 text-muted-foreground", className)} {...props} />;
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("lw-document-icon size-5 shrink-0", className)}
      data-file-kind={kind}
      {...props}
    >
      <defs>
        <linearGradient id={`${id}-paper`} x1="12" y1="3" x2="12" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--lw-surface, #fff)" />
          <stop offset="1" stopColor="var(--lw-asset-front, #f7f7f8)" />
        </linearGradient>
      </defs>
      <path d="M6.5 3.5h7.8L19.5 9v10.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2Z" fill="var(--lw-asset-back, #d6d6da)" opacity=".55" />
      <path d="M6 2.5h7.5L19 8v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2Z" fill={`url(#${id}-paper)`} stroke="var(--lw-asset-edge, #b6b6bd)" strokeWidth=".8" />
      <path d="M13.5 2.5V6.5A1.5 1.5 0 0 0 15 8H19" fill="var(--lw-asset-back, #d6d6da)" stroke="var(--lw-asset-edge, #b6b6bd)" strokeWidth=".8" strokeLinejoin="round" />
      <g stroke="var(--lw-file-accent, #6c6c76)" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
        {kind === "sheet" ? (
          <><rect x="7" y="11" width="9" height="6" rx=".6" /><path d="M7 13.5h9M10.5 11v6" /></>
        ) : kind === "image" ? (
          <><rect x="7" y="10.5" width="9" height="7" rx=".8" /><path d="m7 16 2.7-2.7 2.1 2.1 1.4-1.4 2.8 2.8" /><circle cx="13.5" cy="12.5" r=".55" fill="var(--lw-file-accent, #6c6c76)" stroke="none" /></>
        ) : kind === "html" ? (
          <path d="m9 12-2 2 2 2m5-4 2 2-2 2m-2.1-4.5-.8 5" />
        ) : kind === "slides" ? (
          <><rect x="7" y="10.5" width="9" height="5.5" rx=".6" /><path d="M11.5 16v2m-2 0h4m-4-4.5v1m2-2.5v2.5m2-1.5v1.5" /></>
        ) : kind === "audio" ? (
          <><path d="M11 15.5v-5l4-1v5" /><ellipse cx="9.7" cy="16" rx="1.3" ry="1" /><ellipse cx="13.7" cy="15" rx="1.3" ry="1" /></>
        ) : kind === "video" ? (
          <path d="m9 10.5 6 3.5-6 3.5v-7Z" />
        ) : kind === "pdf" ? (
          <path d="M7 17c4-1 6-6 5-7-1.5-1.5-1.5 7 4 6.5 1.5-.5-4-2-9 .5Z" />
        ) : (
          <><path d="M7.5 11.5h5M7.5 14h8M7.5 16.5h6" /></>
        )}
      </g>
    </svg>
  );
}
