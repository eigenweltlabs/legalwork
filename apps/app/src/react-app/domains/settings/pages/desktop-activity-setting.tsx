import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { currentLocale, t } from "@/i18n";
import { desktopCaptureKey, type DesktopCaptureStatus } from "../../../shell/desktop-time-activity";
import { DesktopHistorySetting } from "./desktop-history-setting";
import { TimeSetting, TimeSwitch } from "../../back-office/time-settings-controls";

export function DesktopActivitySetting({ profileId, checked, disabled, onChange }: {
  profileId: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void;
}) {
  const system = window.__LEGALWORK_ELECTRON__?.system;
  const status = useQuery({
    queryKey: ["timekeeping-desktop-permission"], enabled: Boolean(system?.workdayDesktopStatus),
    queryFn: () => system!.workdayDesktopStatus!(), retry: false, refetchOnWindowFocus: "always",
    refetchInterval: checked ? 15_000 : false,
  });
  const permission = useMutation({
    mutationFn: () => system!.requestWorkdayDesktopPermission!(),
    onSettled: () => status.refetch(),
  });
  const last = useQuery({
    queryKey: desktopCaptureKey(profileId), enabled: false, queryFn: async (): Promise<DesktopCaptureStatus | null> => null,
  }).data;
  if (!system?.workdayDesktopStatus) return null;
  const platform = status.data?.platform;
  if (platform === "unsupported" && !checked) return null;
  const unavailable = status.isError || status.data?.permission === "unavailable";
  const fileHistory = Boolean(system.importWorkdayFileHistory && (platform === "darwin" || platform === "win32"));
  return <>
    <TimeSwitch label={t("timeWorkspace.desktopActivity")} checked={checked}
      disabled={disabled || (!checked && (!platform || (unavailable && !fileHistory)))} onChange={onChange}
      description={t(unavailable ? (fileHistory ? "timeWorkspace.historyOnly" : "timeWorkspace.desktopUnavailable") : platform === "darwin" ? "timeWorkspace.desktopHelpMac" : "timeWorkspace.desktopHelp")} />
    {checked && platform === "darwin" && status.data?.permission === "needed" && <TimeSetting
      title={t("timeWorkspace.desktopDocuments")} description={t("timeWorkspace.desktopDocumentHelp")}>
      <Button size="sm" variant="outline" disabled={disabled || permission.isPending}
        onClick={() => permission.mutate()}>{t("timeWorkspace.desktopGrant")}</Button>
    </TimeSetting>}
    {checked && <p className="px-5 py-3 text-xs text-muted-foreground" role="status">
      {permission.isError || last?.state === "failed" ? t("timeWorkspace.desktopFailed") :
        !last ? t("timeWorkspace.desktopWaiting") : t("timeWorkspace.desktopLatest", {
          time: new Date(last.at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" }),
          state: t("timeWorkspace.desktopState." + last.state),
        })}
    </p>}
    {checked && fileHistory && <DesktopHistorySetting key={profileId} profileId={profileId} disabled={disabled} />}
  </>;
}
