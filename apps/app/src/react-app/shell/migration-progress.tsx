/** @jsxImportSource react */
import type { MigrationProgress } from "@legalwork/types/migration-progress";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n";
import { formatBytes } from "../../app/utils";

const phases: Record<MigrationProgress["phase"], string> = {
  history: "boot.migration_history",
  inspecting: "boot.migration_inspecting",
  copying: "boot.migration_copying",
  verifying: "boot.migration_verifying",
  "finding-chats": "boot.migration_finding_chats",
  chats: "boot.migration_chats",
  references: "boot.migration_references",
  backup: "boot.migration_backup",
  finishing: "boot.migration_finishing",
};

function workDescription(work: NonNullable<MigrationProgress["work"]>) {
  const completed = work.unit === "bytes" ? formatBytes(work.completed) : work.completed.toLocaleString();
  const total = work.total === undefined ? undefined : work.unit === "bytes" ? formatBytes(work.total) : work.total.toLocaleString();
  const unit = {
    bytes: t("boot.migration_unit_bytes"),
    files: t("boot.migration_unit_files"),
    chats: t("boot.migration_unit_chats"),
    items: t("boot.migration_unit_items"),
  }[work.unit];
  return total === undefined ? t("boot.migration_count", { completed, unit }) : t("boot.migration_count_total", { completed, total, unit });
}

export function MigrationProgressView({ progress }: { progress: MigrationProgress }) {
  const label = t(phases[progress.phase]);
  const work = progress.work;
  const percent = work?.total !== undefined && work.total > 0
    ? Math.min(100, Math.max(0, Math.floor(work.completed / work.total * 100))) : null;
  const description = work ? workDescription(work) : null;
  return (
    <div className="flex w-full flex-col gap-3" data-testid="migration-progress">
      <div className="text-[13px] font-medium leading-5 text-dls-primary">{label}</div>
      {progress.detail ? <div className="break-words text-[12px] leading-5 text-dls-secondary">{progress.detail}</div> : null}
      {progress.project ? (
        <div className="text-[12px] leading-5 text-dls-secondary">
          <div className="break-words">{progress.project.name}</div>
          <div>{t("boot.migration_project", { current: progress.project.index, total: progress.project.total })}</div>
        </div>
      ) : null}
      <Progress
        value={percent}
        aria-label={label}
        aria-valuetext={description ?? label}
        className={`w-full [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-dls-hover [&_[data-slot=progress-indicator]]:bg-dls-accent${percent === null ? " [&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-pulse motion-reduce:[&_[data-slot=progress-indicator]]:animate-none" : ""}`}
      />
      <div aria-live="off" className="flex flex-wrap justify-between gap-2 text-[11px] tabular-nums text-dls-secondary">
        {description ? <span>{description}</span> : null}
        {percent !== null ? <span>{t("boot.migration_step_percent", { percent })}</span> : null}
      </div>
      <div className="text-[12px] font-medium leading-5 text-dls-primary">{t("boot.migration_keep_open")}</div>
    </div>
  );
}
