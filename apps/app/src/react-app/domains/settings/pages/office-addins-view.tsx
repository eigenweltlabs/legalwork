/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Info, XCircle } from "lucide-react";

import type { OfficeAddinStatus } from "@legalwork/types/desktop-ipc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

function AppsList({ status }: { status: OfficeAddinStatus }) {
  const installedApps = status.apps.filter((app) => app.installed);
  if (installedApps.length === 0) {
    return (
      <p className="text-sm text-dls-secondary">{t("office_addins.no_office_apps")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {installedApps.map((app) => (
        <StatusRow
          key={app.id}
          ok={app.manifestInstalled && status.enabled}
          label={
            app.manifestInstalled && status.enabled
              ? t("office_addins.app_ready", { app: app.label })
              : t("office_addins.app_not_installed", { app: app.label })
          }
        />
      ))}
    </div>
  );
}

export function OfficeAddinsView() {
  const queryClient = useQueryClient();
  const desktop = isDesktopRuntime();

  const statusQuery = useQuery({
    queryKey: OFFICE_STATUS_KEY,
    queryFn: () => desktopBridge.officeAddinStatus(),
    enabled: desktop,
    refetchOnWindowFocus: false,
  });

  const applyResult = (result: { ok: boolean; error?: string; status: OfficeAddinStatus }, verb: string) => {
    queryClient.setQueryData(OFFICE_STATUS_KEY, result.status);
    if (result.ok) {
      toast.success(t(`office_addins.${verb}_success`));
    } else {
      toast.warning(result.error ?? t(`office_addins.${verb}_failed`));
    }
  };

  const installMutation = useMutation({
    mutationFn: () => desktopBridge.officeAddinInstall(),
    onSuccess: (result) => applyResult(result, "install"),
    onError: (error: unknown) => toast.warning(error instanceof Error ? error.message : String(error)),
  });

  const uninstallMutation = useMutation({
    mutationFn: () => desktopBridge.officeAddinUninstall(),
    onSuccess: (result) => applyResult(result, "uninstall"),
    onError: (error: unknown) => toast.warning(error instanceof Error ? error.message : String(error)),
  });

  const busy = installMutation.isPending || uninstallMutation.isPending;
  const status = statusQuery.data;

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

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("office_addins.status_title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            {status?.enabled
              ? t("office_addins.status_enabled")
              : t("office_addins.status_disabled")}
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            {status?.enabled ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !status?.supported}
                onClick={() => uninstallMutation.mutate()}
              >
                {uninstallMutation.isPending
                  ? t("office_addins.uninstalling")
                  : t("office_addins.uninstall")}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || !status?.supported || !status?.toolAvailable}
                onClick={() => installMutation.mutate()}
              >
                {installMutation.isPending
                  ? t("office_addins.installing")
                  : t("office_addins.install")}
              </Button>
            )}
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        {statusQuery.isLoading ? (
          <p className="text-sm text-dls-secondary">{t("office_addins.loading")}</p>
        ) : status ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <StatusRow ok={status.certTrusted} label={t("office_addins.cert_trusted")} />
              <StatusRow ok={status.enabled} label={t("office_addins.listener_running", { port: status.port })} />
            </div>
            <AppsList status={status} />
          </div>
        ) : null}
      </LayoutSectionItem>

      {status?.enabled ? (
        <p className="px-1 text-xs text-dls-secondary">{t("office_addins.restart_hint")}</p>
      ) : (
        <p className="px-1 text-xs text-dls-secondary">{t("office_addins.install_hint")}</p>
      )}
    </LayoutStack>
  );
}
