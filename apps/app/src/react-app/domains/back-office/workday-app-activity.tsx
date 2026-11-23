import { useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ItemDialogContent } from "@/react-app/design-system/item-detail";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function WorkdayAppActivity({ client, profileId, date, container }: {
  client: LegalworkServerClient; profileId: string; date: string; container: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const activity = useQuery({
    queryKey: ["workday-app-activity", client.baseUrl, profileId, date, zone], enabled: open,
    queryFn: ({ signal }) => client.workdayAppActivity(profileId, date, zone, signal),
    refetchInterval: open ? 30_000 : false, retry: false,
  });
  const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <>
    <Button size="icon-sm" variant="ghost" aria-label={t("timeWorkspace.appActivity")} title={t("timeWorkspace.appActivity")} onClick={() => setOpen(true)}><History /></Button>
    <Dialog open={open} modal={false} onOpenChange={value => setOpen(value)}>
      <ItemDialogContent container={container} className="max-h-[calc(100%-1rem)] w-[calc(100%-1rem)] sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4"><DialogTitle>{t("timeWorkspace.appActivity")} · {date}</DialogTitle></DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-3 text-sm">
          {activity.isLoading && <p role="status">{t("common.loading")}</p>}
          {activity.error && <p role="alert">{activity.error.message}</p>}
          {activity.data?.length === 0 && <p>{t("timeWorkspace.appActivityEmpty")}</p>}
          <ol className="divide-y">{activity.data?.map(row => {
            const start = row.startAt ?? row.observedAt;
            const status = row.source === "agent" ? t(row.agentVisibility === "foreground" ? "timeWorkspace.agentInFocus" :
              row.agentVisibility === "background" ? "timeWorkspace.agentInBackground" : "timeWorkspace.agentFocusUnknown") :
              row.observation === "foreground" ? t("timeWorkspace.foreground") : row.observation === "passive" ? t("timeWorkspace.passive") : null;
            return <li key={row.digest} className="py-2">
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                {start && <time dateTime={start}>{clock.format(new Date(start))}{row.endAt && " – " + clock.format(new Date(row.endAt))}</time>}
                {row.startAt && row.endAt && <span>{new Intl.NumberFormat(undefined, { style: "unit", unit: "minute", maximumFractionDigits: 1 }).format((Date.parse(row.endAt) - Date.parse(row.startAt)) / 60_000)}</span>}
                {status && <strong>{status}</strong>}
                {row.projectName && <span>{row.projectName}</span>}
              </div>
              <p className="break-words">{row.narrative}</p>
              {row.changeSummary && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{row.changeSummary}</p>}
            </li>;
          })}</ol>
        </div>
      </ItemDialogContent>
    </Dialog>
  </>;
}
