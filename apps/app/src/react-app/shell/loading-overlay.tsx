/** @jsxImportSource react */
import { useState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUpdateCheckRequestStore } from "../domains/settings/state/update-check-request";
import { supportBundleCollect } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { useBootState, useBootOverlayVisible } from "./boot-state";
import { OwDotTicker } from "./dot-ticker";
import { SettingsSurface } from "./settings-route";
import { openErrorReport, recordError } from "@/app/lib/error-reports";
import { t } from "@/i18n";

const RELEASES_URL = "https://github.com/eigenweltlabs/legalwork/releases";

/**
 * One-click support-log collection for the boot error screen. The customer
 * whose local server never starts is stuck exactly here, so this is the one
 * place a "get me the logs" affordance must exist inside the UI (the native
 * Help menu carries the same action for every other situation).
 */
function CollectLogsButton() {
  const [state, setState] = useState<
    { status: "idle" | "collecting" | "failed" } | { status: "done"; path: string }
  >({ status: "idle" });

  const collect = async () => {
    setState({ status: "collecting" });
    try {
      const result = (await supportBundleCollect()) as { path?: string | null };
      if (!result?.path) {
        // User canceled the save dialog — quietly return to the idle button.
        setState({ status: "idle" });
        return;
      }
      setState({ status: "done", path: result.path });
    } catch (error) {
      console.error("[boot-overlay] support bundle collection failed:", error);
      setState({ status: "failed" });
    }
  };

  if (state.status === "done") {
    return (
      <div className="text-[11px] leading-4 text-dls-secondary">
        Log file saved to {state.path}. Please send it to support.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void collect()}
        disabled={state.status === "collecting"}
      >
        {state.status === "collecting" ? t("boot.collecting_logs") : t("boot.collect_logs")}
      </Button>
      {state.status === "failed" ? (
        <div className="text-[11px] leading-4 text-dls-secondary">
          {t("app.collect_logs_failed")}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Quiet, opaque boot overlay. Solid surface fill so nothing bleeds through.
 * A minimal typographic beat plus a small dot ticker. Fades once both the
 * boot hook and the first route load are ready.
 */
export function LoadingOverlay() {
  const visible = useBootOverlayVisible();
  const { phase, message, error } = useBootState();
  const [incidentId, setIncidentId] = useState<string | null>(null);
  useEffect(() => {
    if (!error) { setIncidentId(null); return; }
    const diagnostic = recordError(new Error(error), { source: "startup", operation: "startup", phase: "startup", component: "desktop" });
    setIncidentId(diagnostic?.incident_id ?? null);
  }, [error]);
  const [updatesOpen, setUpdatesOpen] = useState(false);

  const openUpdates = () => {
    useUpdateCheckRequestStore.getState().requestUpdateCheck();
    setUpdatesOpen(true);
  };

  if (!visible) return null;

  const fading = phase === "ready";

  return (
    <div
      className={`fixed inset-0 z-[1000] flex items-center justify-center bg-dls-surface transition-opacity duration-[160ms] ${
        fading ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!fading}
      role="status"
    >
      <div className="flex w-full max-w-[320px] flex-col items-center gap-4 px-6 text-center">
        <OwDotTicker size="md" />
        <div className="text-[12px] leading-5 text-dls-secondary">
          {message || t("boot.preparing_workspace")}
        </div>
        {error ? (
          <div className="flex flex-col items-center gap-3 text-[12px] leading-5 text-red-11">
            <div>{error}</div>
            {incidentId ? <Button variant="outline" size="sm" onClick={() => openErrorReport(incidentId)}>{t("error_report.share")}</Button> : null}
            {isDesktopRuntime() ? (
              <>
                <Button variant="outline" size="sm" className="absolute bottom-6 right-6" onClick={openUpdates}>
                  {t("ai_plans.check_updates")}
                </Button>
                <CollectLogsButton />
                <Dialog open={updatesOpen} onOpenChange={setUpdatesOpen}>
                  {/* Keep the updater and its menus above the boot overlay. */}
                  <DialogContent
                    className="flex max-h-[calc(100vh-2rem)] min-h-0 flex-col gap-0 bg-background p-0 sm:max-w-2xl"
                    portalClassName="relative z-[1001]"
                  >
                    <DialogHeader className="px-6 pb-1 pt-6">
                      <DialogTitle>{t("settings.tab_updates")}</DialogTitle>
                      <DialogDescription>{t("settings.tab_description_updates")}</DialogDescription>
                    </DialogHeader>
                    {updatesOpen ? (
                      <div className="flex min-h-0 flex-1 flex-col">
                        <SettingsSurface embedded singleView initialPath="updates" />
                      </div>
                    ) : null}
                  </DialogContent>
                </Dialog>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
