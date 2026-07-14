/** @jsxImportSource react */
import { Check, FolderPlus, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import type { WorkspacePreset } from "../../../app/types";
import { t } from "../../../i18n";
import {
  errorBannerClass,
  modalBodyClass,
  pillGhostClass,
  pillSecondaryClass,
  softCardClass,
  tagClass,
  warningBannerClass,
} from "./modal-styles";

export type CreateWorkspaceProgressStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string | null;
};

export type CreateWorkspaceProgressSnapshot = {
  runId: string;
  startedAt: number;
  stage: string;
  error: string | null;
  steps: CreateWorkspaceProgressStep[];
  logs: string[];
};

export type CreateWorkspaceLocalPanelProps = {
  selectedFolder: string | null;
  hasSelectedFolder: boolean;
  pickingFolder: boolean;
  onPickFolder: () => void;
  submitting: boolean;
  localError: string | null;
  onClose: () => void;
  onSubmit: () => void;
  confirmLabel?: string;
  workerLabel?: string;
  onConfirmWorker?: (preset: WorkspacePreset, folder: string | null) => void;
  preset: WorkspacePreset;
  workerSubmitting: boolean;
  workerDisabled: boolean;
  workerDisabledReason: string | null;
  workerCtaLabel?: string;
  workerCtaDescription?: string;
  onWorkerCta?: () => void;
  workerRetryLabel?: string;
  onWorkerRetry?: () => void;
  workerDebugLines: string[];
  progress: CreateWorkspaceProgressSnapshot | null;
  elapsedSeconds: number;
  showProgressDetails: boolean;
  onToggleProgressDetails: () => void;
};

function stepIcon(status: CreateWorkspaceProgressStep["status"]) {
  if (status === "done")
    return <XCircle size={16} className="text-emerald-10" />;
  if (status === "active")
    return <Loader2 size={16} className="animate-spin text-dls-accent" />;
  if (status === "error") return <XCircle size={16} className="text-red-10" />;
  return <div className="size-4 rounded-full border-2 border-dls-border" />;
}

function toKeyedLines(lines: string[]) {
  let offset = 0;
  return lines.map((line) => {
    const key = `${offset}:${line}`;
    offset += line.length + 1;
    return { key, line };
  });
}

function stepTextClass(status: CreateWorkspaceProgressStep["status"]) {
  if (status === "done") return "text-dls-text font-medium";
  if (status === "active") return "text-dls-text font-semibold";
  if (status === "error") return "text-red-11 font-medium";
  return "text-dls-secondary";
}

function folderName(path: string | null): string {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

export function CreateWorkspaceLocalPanel(
  props: CreateWorkspaceLocalPanelProps,
) {
  const progress = props.progress;

  return (
    <>
      <div
        className={`${modalBodyClass} transition-opacity duration-300 ${props.submitting ? "pointer-events-none opacity-40" : "opacity-100"}`}
      >
        <div className="space-y-5">
          <div className="space-y-3">
            <p className="text-[14px] leading-relaxed text-dls-secondary">
              {t("welcome.folder_explanation")}
            </p>
            <ul className="space-y-2">
              {[
                t("welcome.folder_read"),
                t("welcome.folder_write"),
                t("welcome.folder_anything"),
              ].map((label) => (
                <li
                  key={label}
                  className="flex items-start gap-2.5 text-[13px] leading-snug text-dls-text"
                >
                  <Check
                    size={15}
                    strokeWidth={2.25}
                    className="mt-px shrink-0 text-emerald-10"
                  />
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          </div>

          {props.hasSelectedFolder ? (
            <div className="flex items-center gap-3 rounded-2xl border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)]">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-3 text-emerald-11">
                <Check size={18} strokeWidth={2.5} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-dls-text">
                  {folderName(props.selectedFolder)}
                </div>
                <div className="truncate font-mono text-[11px] text-dls-secondary">
                  {props.selectedFolder}
                </div>
              </div>
              <button
                type="button"
                onClick={props.onPickFolder}
                disabled={props.pickingFolder || props.submitting}
                className={pillGhostClass}
              >
                {props.pickingFolder ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : null}
                {t("dashboard.change")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={props.onPickFolder}
              disabled={props.pickingFolder || props.submitting}
              className="group flex w-full items-center gap-3.5 rounded-2xl border border-dashed border-dls-border bg-dls-hover p-4 text-left transition-all duration-150 hover:border-[rgba(var(--dls-accent-rgb),0.35)] hover:bg-dls-surface hover:shadow-[var(--dls-card-shadow)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface text-dls-secondary transition-colors group-hover:text-dls-accent">
                {props.pickingFolder ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <FolderPlus size={18} />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-dls-text">
                  {t("welcome.folder_select")}
                </span>
                <span className="block text-[12px] text-dls-secondary">
                  {t("welcome.folder_browse_hint")}
                </span>
              </span>
            </button>
          )}

          <p className="text-[12px] italic leading-relaxed text-dls-secondary">
            {t("welcome.folder_drop_hint")}
          </p>
        </div>
      </div>

    <DialogFooter className="flex-col gap-3">
        {props.submitting && progress ? (
          <div className={softCardClass}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-dls-text">
                  {progress.error ? (
                    <XCircle size={14} className="text-red-11" />
                  ) : (
                    <Loader2 size={14} className="animate-spin text-dls-accent" />
                  )}
                  Sandbox setup
                </div>
                <div className="mt-1 truncate text-[14px] leading-snug text-dls-text">
                  {progress.stage}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-dls-secondary">
                  {props.elapsedSeconds}s
                </div>
              </div>
              <button
                type="button"
                className={pillGhostClass}
                onClick={props.onToggleProgressDetails}
              >
                {props.showProgressDetails ? "Hide logs" : "Show logs"}
              </button>
            </div>

            {progress.error ? (
              <div className={`mt-3 ${errorBannerClass}`}>{progress.error}</div>
            ) : null}

            <div className="mt-4 grid gap-2.5">
              {progress.steps.map((step) => (
                <div key={step.key} className="flex items-center gap-3">
                  <div className="flex size-5 shrink-0 items-center justify-center">
                    {stepIcon(step.status)}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <div
                      className={`text-[12px] ${stepTextClass(step.status)} transition-colors duration-200`.trim()}
                    >
                      {step.label}
                    </div>
                    {step.detail?.trim() ? (
                      <div
                        className={`${tagClass} max-w-[120px] truncate font-mono`}
                      >
                        {step.detail}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {props.showProgressDetails && progress.logs.length > 0 ? (
              <div className={`mt-3 ${softCardClass}`}>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary">
                  Live logs
                </div>
                <div className="max-h-[120px] space-y-0.5 overflow-y-auto">
                  {toKeyedLines(progress.logs.slice(-10)).map(({ key, line }) => (
                    <div
                      key={`${progress.runId}-log-${key}`}
                      className="break-all font-mono text-[10px] leading-tight text-dls-text"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {props.onConfirmWorker &&
        props.workerDisabled &&
        props.workerDisabledReason ? (
          <div className={warningBannerClass}>
            <div className="font-semibold text-amber-12">
              {t("dashboard.sandbox_get_ready_title")}
            </div>
            <div className="mt-1 leading-relaxed">
              {props.workerDisabledReason || props.workerCtaDescription}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {props.onWorkerCta && props.workerCtaLabel?.trim() ? (
                <button
                  type="button"
                  className={pillSecondaryClass}
                  onClick={props.onWorkerCta}
                  disabled={props.submitting}
                >
                  {props.workerCtaLabel}
                </button>
              ) : null}
              {props.onWorkerRetry && props.workerRetryLabel?.trim() ? (
                <button
                  type="button"
                  className={pillGhostClass}
                  onClick={props.onWorkerRetry}
                  disabled={props.submitting}
                >
                  {props.workerRetryLabel}
                </button>
              ) : null}
            </div>
            {props.workerDebugLines.length > 0 ? (
              <details
                className={`mt-3 ${softCardClass} text-[11px] text-dls-text`}
              >
                <summary className="cursor-pointer text-[12px] font-semibold text-dls-text">
                  Docker debug details
                </summary>
                <div className="mt-2 space-y-1 break-words font-mono">
                  {toKeyedLines(props.workerDebugLines).map(({ key, line }) => (
                    <div key={`docker-line-${key}`}>{line}</div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {props.localError ? (
          <div className="mb-3 whitespace-pre-line rounded-[20px] border border-red-7/20 bg-red-1/40 px-4 py-3 text-[13px] text-red-11">
            {props.localError}
          </div>
        ) : null}

        <div className="flex justify-end gap-3">
          <DialogClose
            disabled={props.submitting}
            render={<Button variant="outline" disabled={props.submitting} />}
          >
            {t("common.cancel")}
          </DialogClose>
          {props.onConfirmWorker ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                props.onConfirmWorker?.(props.preset, props.selectedFolder)
              }
              disabled={
                !props.selectedFolder ||
                props.submitting ||
                props.workerSubmitting ||
                props.workerDisabled
              }
              title={
                !props.selectedFolder
                  ? t("dashboard.choose_folder_continue")
                  : props.workerDisabledReason || undefined
              }
            >
              {props.workerSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {t("dashboard.sandbox_checking_docker")}
                </span>
              ) : (
                (props.workerLabel ??
                  t("dashboard.create_sandbox_confirm"))
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void props.onSubmit()}
            disabled={!props.selectedFolder || props.submitting}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-sunken disabled:text-tertiary disabled:opacity-100"
            title={
              !props.selectedFolder
                ? t("dashboard.choose_folder_continue")
                : undefined
            }
          >
            {props.submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                Creating…
              </span>
            ) : (
              (props.confirmLabel ??
                t("dashboard.create_workspace_confirm"))
            )}
          </Button>
        </div>
    </DialogFooter>
    </>
  );
}
