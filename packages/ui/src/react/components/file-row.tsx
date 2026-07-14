import { forwardRef } from "react";
import { FileText } from "lucide-react";
import { cn } from "../utils/cn";

const FILE_COLORS: Record<string, string> = {
  docx: "#2b7de9",
  doc: "#2b7de9",
  pdf: "#e5484d",
  xlsx: "#12a150",
  md: "#6c6c76",
  txt: "#6c6c76",
};

export interface FileRowProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
  /** e.g. "Document", "Spreadsheet". */
  kind?: string;
  /** Extension label; also drives the icon tint. */
  ext?: string;
  trailing?: React.ReactNode;
  interactive?: boolean;
}

/** Document row: tinted file glyph, name, "Kind · EXT" meta, trailing action. */
export const FileRow = forwardRef<HTMLDivElement, FileRowProps>(function FileRow(
  { className, name, kind = "Document", ext, trailing, interactive, ...rest },
  ref,
) {
  const extLabel = (ext ?? name.split(".").pop() ?? "").toUpperCase();
  const color = FILE_COLORS[extLabel.toLowerCase()] ?? "#6c6c76";
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-subtle bg-surface px-3 py-2.5",
        interactive && "cursor-pointer transition-colors hover:bg-surface-hover",
        className,
      )}
      {...rest}
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-lg"
        style={{ background: `${color}14`, color }}
      >
        <FileText className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium text-ink">{name}</div>
        <div className="text-sm text-subtext">
          {kind}
          {extLabel ? <span className="text-tertiary"> · {extLabel}</span> : null}
        </div>
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
});
