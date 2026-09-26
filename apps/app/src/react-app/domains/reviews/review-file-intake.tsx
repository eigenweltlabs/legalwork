import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FilePlus2 } from "lucide-react";
import { REVIEW_FILE_EXTENSIONS } from "@legalwork/types/reviews";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { acceptsReviewFiles, importReviewFiles, readReviewFiles, type ReviewFileClient, type ReviewFileSource } from "./review-file-import";

export function useReviewFileIntake({ client, workspaceId, existing, onFiles }: {
  client: ReviewFileClient; workspaceId: string; existing: string[]; onFiles: (paths: string[]) => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const active = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => () => { active.current?.abort(); }, [workspaceId]);
  const add = async (sources: ReviewFileSource[]) => {
    if (active.current) return;
    if (!sources.length) { setError(new Error(t("review.file_drop_invalid"))); return; }
    const controller = new AbortController(); active.current = controller;
    setError(null); setProgress(t("review.importing"));
    try {
      const result = await importReviewFiles({ client, workspaceId, sources, existing, signal: controller.signal,
        onProgress: (index, total, name) => setProgress(t("review.import_progress", { index, total, name })),
      });
      if (result.paths.length) await onFiles(result.paths);
      if (!controller.signal.aborted && result.failures.length) setError(new Error(result.failures.join("\n")));
      for (const key of ["workspace-files", "project-files", "review-file-picker"]) void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause : new Error(t("review.failed")));
    } finally {
      if (active.current === controller) { active.current = null; setProgress(""); }
    }
  };
  return { add, progress, error, busy: !!progress };
}

export function ReviewFileDropTarget({ children, disabled, onFiles, className }: {
  children: ReactNode; disabled?: boolean; onFiles: (sources: ReviewFileSource[]) => void; className?: string;
}) {
  const [over, setOver] = useState(false);
  return <div className={cn("relative", className)} onDragOver={event => {
    if (!acceptsReviewFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    setOver(!disabled);
  }} onDragLeave={event => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOver(false);
  }} onDrop={event => {
    if (!acceptsReviewFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); setOver(false);
    if (!disabled) onFiles(readReviewFiles(event.dataTransfer));
  }} onDragEnd={() => setOver(false)}>
    {children}
    {over && !disabled && <div className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-background/95 p-6 text-center"><FilePlus2 className="size-8 text-muted-foreground" /><p className="text-base font-medium">{t("review.drop_here")}</p><p className="text-sm text-muted-foreground">{t("review.drop_sources")}</p></div>}
  </div>;
}

export function ReviewFilePicker({ onFiles, disabled, label = t("review.add_files") }: {
  onFiles: (sources: ReviewFileSource[]) => void; disabled?: boolean; label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" multiple accept={REVIEW_FILE_EXTENSIONS.map(extension => `.${extension}`).join(",")} className="hidden" aria-label={t("review.choose_computer")} disabled={disabled} onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
      if (files.length) onFiles(files.map(file => ({ kind: "upload", file })));
    }} />
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()}><FilePlus2 className="size-4" />{label}</Button>
  </>;
}
