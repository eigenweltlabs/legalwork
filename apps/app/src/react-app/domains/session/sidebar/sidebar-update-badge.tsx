/** @jsxImportSource react */
import * as React from "react";
import { RefreshCcw, X } from "lucide-react";

import { isElectronRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { checkForUpdatesInBackground } from "../../settings/state/electron-updater-state";
import { useUpdateStatusStore } from "../../settings/state/update-status-store";

type SidebarUpdateBadgeProps = {
  /** Open the settings Updates page (clicking the badge). */
  onOpenUpdatesSettings: () => void;
};

/**
 * Compact update card shown in the home sidebar under the top nav when a
 * new app version is available. The whole card links to the settings
 * Updates page, where the already-completed check leaves the download
 * immediately actionable.
 */
export function SidebarUpdateBadge(props: SidebarUpdateBadgeProps) {
  const status = useUpdateStatusStore((state) => state.status);
  const dismissedVersion = useUpdateStatusStore((state) => state.dismissedVersion);
  const dismissVersion = useUpdateStatusStore((state) => state.dismissVersion);

  React.useEffect(() => {
    void checkForUpdatesInBackground();
  }, []);

  if (!isElectronRuntime()) return null;
  const state = status?.state;
  if (state !== "available" && state !== "downloading" && state !== "ready") return null;
  const version = status?.version ?? null;
  if (dismissedVersion === (version ?? "unknown")) return null;

  const downloadedBytes = status?.downloadedBytes ?? 0;
  const totalBytes = status?.totalBytes ?? null;
  const downloadPercent =
    totalBytes != null && totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;

  return (
    <div className="mt-auto px-2 pt-2 mac:titlebar-no-drag">
      <div className="group relative rounded-lg border border-[color:var(--glass-border)] bg-sidebar-accent transition-colors mac:bg-black/5 mac:hover:bg-black/10 dark:mac:bg-white/10 dark:mac:hover:bg-white/15">
        <button
          type="button"
          onClick={props.onOpenUpdatesSettings}
          className="flex w-full items-center gap-2 p-3 pr-8 text-left"
        >
          <RefreshCcw className="size-4 shrink-0 text-sidebar-accent-foreground" strokeWidth={2.5} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-sidebar-accent-foreground">
              {state === "ready"
                ? t("sidebar.update_ready_title")
                : state === "downloading"
                  ? t("settings.update_downloading")
                  : t("sidebar.update_available_title")}
            </div>
            {state === "downloading" ? (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-sidebar-foreground/10">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${downloadPercent}%` }}
                />
              </div>
            ) : null}
          </div>
        </button>
        <button
          type="button"
          aria-label={t("sidebar.update_dismiss")}
          title={t("sidebar.update_dismiss")}
          onClick={() => dismissVersion(version ?? "unknown")}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-sidebar-foreground/50 hover:text-sidebar-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
