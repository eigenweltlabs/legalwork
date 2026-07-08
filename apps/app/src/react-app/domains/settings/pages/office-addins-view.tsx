/** @jsxImportSource react */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";

import type { OfficeAddinAppId, OfficeAddinStatus } from "@legalwork/types/desktop-ipc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { desktopBridge } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";

const OFFICE_STATUS_KEY = ["office-addins", "status"] as const;

function StatusRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="size-4 text-green-9" />
      ) : (
        <XCircle className="size-4 text-gray-8" />
      )}
      <span className={ok ? "text-dls-text" : "text-dls-secondary"}>{label}</span>
    </div>
  );
}

export function OfficeAddinsView() {
  const queryClient = useQueryClient();
  const desktop = isDesktopRuntime();
  const [busyApp, setBusyApp] = useState<OfficeAddinAppId | null>(null);
  /** App awaiting the certificate explainer's confirmation. */
  const [confirmApp, setConfirmApp] = useState<OfficeAddinAppId | null>(null);
  /** App awaiting the last-uninstall explainer's confirmation. */
  const [confirmUninstallApp, setConfirmUninstallApp] = useState<OfficeAddinAppId | null>(null);
  /** Label of the app whose post-install "restart" notice is showing. */
  const [restartApp, setRestartApp] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: OFFICE_STATUS_KEY,
    queryFn: () => desktopBridge.officeAddinStatus(),
    enabled: desktop,
    refetchOnWindowFocus: false,
  });

  const installMutation = useMutation({
    mutationFn: (app: OfficeAddinAppId) => {
      setBusyApp(app);
      return desktopBridge.officeAddinInstall(app);
    },
    onSuccess: (result, app) => {
      queryClient.setQueryData(OFFICE_STATUS_KEY, result.status);
      if (result.ok) {
        const label = result.status.apps.find((entry) => entry.id === app)?.label ?? app;
        setRestartApp(label);
      } else {
        toast.warning(result.error ?? t("office_addins.install_failed"));
      }
    },
    onError: (error: unknown) => toast.warning(error instanceof Error ? error.message : String(error)),
    onSettled: () => setBusyApp(null),
  });

  const uninstallMutation = useMutation({
    mutationFn: (app: OfficeAddinAppId) => {
      setBusyApp(app);
      return desktopBridge.officeAddinUninstall(app);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(OFFICE_STATUS_KEY, result.status);
      if (result.ok) {
        toast.success(t("office_addins.uninstall_success"));
      } else {
        toast.warning(result.error ?? t("office_addins.uninstall_failed"));
      }
    },
    onError: (error: unknown) => toast.warning(error instanceof Error ? error.message : String(error)),
    onSettled: () => setBusyApp(null),
  });

  /** Explain the upcoming OS password prompt before the first cert install. */
  const requestInstall = (app: OfficeAddinAppId) => {
    if (statusQuery.data?.certTrusted) {
      installMutation.mutate(app);
    } else {
      setConfirmApp(app);
    }
  };

  /**
   * Explain the possible OS password prompt before the LAST uninstall — the
   * trusted certificate is only removed from the keychain when no Office app
   * remains installed; other uninstalls just delete a manifest.
   */
  const requestUninstall = (app: OfficeAddinAppId) => {
    const enabledApps = statusQuery.data?.apps.filter((entry) => entry.enabled) ?? [];
    const isLast = enabledApps.length === 1 && enabledApps[0]?.id === app;
    if (isLast) {
      setConfirmUninstallApp(app);
    } else {
      uninstallMutation.mutate(app);
    }
  };

  const openApp = async (app: OfficeAddinAppId, label: string) => {
    try {
      const result = await desktopBridge.officeAddinOpenApp(app);
      if (!result.ok) {
        toast.warning(result.error ?? t("office_addins.open_app_failed", { app: label }));
      }
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : String(error));
    }
  };

  const busy = installMutation.isPending || uninstallMutation.isPending;
  const status = statusQuery.data;
  /** The trust-store prompts differ: keychain password on macOS, a security dialog on Windows. */
  const isWindows = status?.platform === "win32";

  if (!desktop) {
    return (
      <LayoutStack>
        <Alert>
          <Info />
          <AlertTitle>{t("office_addins.requires_desktop_title")}</AlertTitle>
          <AlertDescription>{t("office_addins.requires_desktop")}</AlertDescription>
        </Alert>
      </LayoutStack>
    );
  }

  const detectedApps = status?.apps.filter((app) => app.installed) ?? [];

  return (
    <LayoutStack>
      <Alert>
        <Info />
        <AlertTitle>{t("office_addins.about_title")}</AlertTitle>
        <AlertDescription>{t("office_addins.about_body")}</AlertDescription>
      </Alert>

      {status && !status.supported ? (
        <Alert>
          <Info />
          <AlertTitle>{t("office_addins.unsupported_title")}</AlertTitle>
          <AlertDescription>{t("office_addins.unsupported_body")}</AlertDescription>
        </Alert>
      ) : null}

      {statusQuery.isLoading ? (
        <p className="px-1 text-sm text-dls-secondary">{t("office_addins.loading")}</p>
      ) : null}

      {status && detectedApps.length === 0 ? (
        <Alert>
          <Info />
          <AlertTitle>{t("office_addins.no_office_apps_title")}</AlertTitle>
          <AlertDescription>{t("office_addins.no_office_apps")}</AlertDescription>
        </Alert>
      ) : null}

      {detectedApps.map((app) => (
        <LayoutSectionItem key={app.id}>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Microsoft {app.label}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {app.enabled
                ? t("office_addins.app_status_installed", { app: app.label })
                : t("office_addins.app_status_not_installed", { app: app.label })}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              {app.enabled ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !status?.supported}
                    onClick={() => requestUninstall(app.id)}
                  >
                    {busyApp === app.id && uninstallMutation.isPending
                      ? t("office_addins.uninstalling")
                      : t("office_addins.uninstall")}
                  </Button>
                  <Button size="sm" onClick={() => void openApp(app.id, app.label)}>
                    {t("office_addins.open_app", { app: app.label })}
                    <ArrowUpRight />
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={busy || !status?.supported || !status?.toolAvailable}
                  onClick={() => requestInstall(app.id)}
                >
                  {busyApp === app.id && installMutation.isPending
                    ? t("office_addins.installing")
                    : t("office_addins.install")}
                </Button>
              )}
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      ))}

      {status && status.enabled ? (
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("office_addins.shared_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("office_addins.shared_desc")}</LayoutSectionItemDescription>
          </LayoutSectionItemHeader>
          <div className="flex flex-col gap-1.5">
            <StatusRow ok={status.certTrusted} label={t("office_addins.cert_trusted")} />
            <StatusRow ok={status.enabled} label={t("office_addins.listener_running", { port: status.port })} />
          </div>
        </LayoutSectionItem>
      ) : null}

      {!status?.enabled ? (
        <p className="px-1 text-xs text-dls-secondary">{t("office_addins.install_hint")}</p>
      ) : null}

      <Dialog
        open={confirmApp !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmApp(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("office_addins.cert_prompt_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-relaxed text-dls-secondary">
            {t(isWindows ? "office_addins.cert_prompt_body_windows" : "office_addins.cert_prompt_body")}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmApp(null)}>
              {t("office_addins.cancel")}
            </Button>
            <Button
              onClick={() => {
                const app = confirmApp;
                setConfirmApp(null);
                if (app) installMutation.mutate(app);
              }}
            >
              {t("office_addins.install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmUninstallApp !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmUninstallApp(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("office_addins.uninstall_prompt_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-relaxed text-dls-secondary">
            {t(
              isWindows
                ? "office_addins.uninstall_prompt_body_windows"
                : "office_addins.uninstall_prompt_body",
            )}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUninstallApp(null)}>
              {t("office_addins.cancel")}
            </Button>
            <Button
              onClick={() => {
                const app = confirmUninstallApp;
                setConfirmUninstallApp(null);
                if (app) uninstallMutation.mutate(app);
              }}
            >
              {t("office_addins.uninstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={restartApp !== null}
        onOpenChange={(open) => {
          if (!open) setRestartApp(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("office_addins.restart_title", { app: restartApp ?? "" })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-relaxed text-dls-secondary">
            {t(isWindows ? "office_addins.restart_body_windows" : "office_addins.restart_body", {
              app: restartApp ?? "",
            })}
          </p>
          <p className="flex items-start gap-2 text-sm leading-relaxed text-dls-secondary">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-11" />
            <span>{t("office_addins.restart_note")}</span>
          </p>
          <DialogFooter>
            <Button onClick={() => setRestartApp(null)}>{t("office_addins.restart_ok")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LayoutStack>
  );
}
