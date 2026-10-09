/** @jsxImportSource react */
import type { StorageTransferProgress } from "@legalwork/types/file-storage";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export function StorageTransferStatus({ label, progress }: { label: string; progress: StorageTransferProgress }) {
  const { phase, completedFiles, totalFiles, elapsedMs } = progress;
  const counts = { completed: completedFiles.toLocaleString(), total: totalFiles === null ? "…" : totalFiles.toLocaleString() };
  const summary = phase === "scanning" ? t("storage.transfer_counting", { count: counts.completed })
    : phase === "verifying" ? t("storage.transfer_verifying", counts)
    : phase === "removing" ? t("storage.transfer_finishing", counts)
    : t("storage.transfer_files", counts);
  const value = phase === "completed" ? 100 : totalFiles ? completedFiles / totalFiles * 100 : null;
  const speed = phase === "transferring" && completedFiles > 0 && elapsedMs > 0
    ? t("storage.transfer_speed", { speed: (completedFiles * 1000 / elapsedMs).toLocaleString(undefined, { maximumFractionDigits: 1 }) }) : null;
  return <div role="status" className="space-y-1.5 px-2 py-1.5 text-xs text-muted-foreground">
    <p className="truncate text-foreground">{label}</p>
    <Progress value={value} aria-label={label} aria-valuetext={summary}
      className={cn("gap-0 [&_[data-slot=progress-track]]:h-1.5", value === null && "[&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-pulse")} />
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 tabular-nums"><span>{summary}</span>{speed && <span>{speed}</span>}</div>
    {progress.currentFile && <p className="truncate text-[10px]" title={progress.currentFile}>{progress.currentFile}</p>}
  </div>;
}
