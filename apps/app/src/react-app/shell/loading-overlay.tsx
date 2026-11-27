/** @jsxImportSource react */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supportAccountQueryOptions } from "../domains/connections/eigenwelt-entitlements";
import { useUpdateCheckRequestStore } from "../domains/settings/state/update-check-request";
import { SupportContactActions } from "../domains/session/sidebar/support-contact-actions";
import { desktopBridge, relaunchDesktopApp, supportBundleCollect } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { useBootState, useBootOverlayVisible } from "./boot-state";
import type { EngineStartupState } from "./engine-startup";
import { OwDotTicker } from "./dot-ticker";
import { SettingsSurface } from "./settings-route";
import { t } from "@/i18n";
import { MigrationProgressView } from "./migration-progress";

function StartupSupportHelp() {
  const helpId = useId();
  const [{ open, lookup }, setHelp] = useState({ open: false, lookup: 0 });
  const account = useQuery(supportAccountQueryOptions());
  const contact = useQuery({
    queryKey: ["startup-support", "contact", helpId, open ? lookup : null], queryFn: () => desktopBridge.startupSupport(true),
    enabled: open && account.data?.authenticated === true, refetchInterval: open ? 30_000 : false,
    gcTime: 0, retry: false,
  });
  if (!account.data?.authenticated || contact.data?.authenticated === false) return null;
  return (
    <div className="grid w-full gap-3">
      <Button variant="outline" size="sm" aria-expanded={open}
        onClick={() => setHelp(current => current.open ? { ...current, open: false } : { open: true, lookup: current.lookup + 1 })}>
        {t("boot.get_help")}
      </Button>
      {open && <div className="text-left text-foreground">
        <SupportContactActions authenticated contact={contact.data?.contact ?? null} loading={contact.isPending}
          unavailable={contact.isError || contact.data?.unavailable === true} />
      </div>}
    </div>
  );
}

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
export function LoadingOverlay({ startup = { status: "ready" } }: { startup?: EngineStartupState }) {
  const visible = useBootOverlayVisible();
  const { phase, message, error: bootError, routeReady } = useBootState();
  const error = startup.status === "error" ? startup.message : bootError;
  const updating = startup.status === "updating" && !error;
  const migration = startup.status === "updating" ? startup.progress : undefined;
  const preparingMessage = phase === "ready" || phase === "idle" ? t("boot.preparing_workspace") : message || t("boot.preparing_workspace");
  const [updatesOpen, setUpdatesOpen] = useState(false);

  const openUpdates = () => {
    useUpdateCheckRequestStore.getState().requestUpdateCheck();
    setUpdatesOpen(true);
  };

  if (!visible && startup.status === "ready" && !updatesOpen) return null;

  const fading = startup.status === "ready" && routeReady && (phase === "ready" || phase === "idle");

  return (
    <div
      data-testid="startup-screen"
      className={`fixed inset-0 z-[1000] flex overflow-y-auto bg-dls-surface transition-opacity duration-[160ms] ${
        fading ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!fading && !error}
      role="status"
    >
      <div className="m-auto flex w-full max-w-[320px] flex-col items-center gap-4 px-6 py-8 text-center">
        <OwDotTicker size="md" />
        <div className="text-[12px] leading-5 text-dls-secondary">
          {error ? t("boot.error") : updating ? t(migration ? "boot.migration_title" : "boot.updating") : preparingMessage}
        </div>
        {updating ? migration ? <MigrationProgressView progress={migration} /> : <div className="text-[12px] leading-5 text-dls-secondary">{t("boot.updating_detail")}</div> : null}
        {error ? (
          <div className="flex flex-col items-center gap-3 text-[12px] leading-5 text-red-11">
            <div>{error}</div>
          </div>
        ) : null}
        {error && isDesktopRuntime() && <div className="grid w-full gap-3">
          <p className="text-xs leading-5 text-dls-secondary">{t("boot.recovery_prompt")}</p>
          <Button size="sm" onClick={openUpdates}>{t("boot.update_and_restart")}</Button>
          <Button variant="ghost" size="sm" onClick={() => void relaunchDesktopApp().catch(() => toast.error(t("settings.restart_failed")))}>
            {t("boot.restart_app")}
          </Button>
          <StartupSupportHelp />
          <CollectLogsButton />
        </div>}
        {isDesktopRuntime() ? (
          <>
            {!error && <Button variant="outline" size="sm" className="absolute bottom-6 right-6" onClick={openUpdates}>
              {t("ai_plans.check_updates")}
            </Button>}
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
    </div>
  );
}
