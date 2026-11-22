import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { TimeSetting } from "../../back-office/time-settings-controls";
import { calendarDay } from "../../calendar/calendar-format";

export function DesktopHistorySetting({ profileId, disabled }: { profileId: string; disabled: boolean }) {
  const today = calendarDay(new Date());
  const [date, setDate] = useState(today);
  const cache = useQueryClient();
  const chooseFolder = window.__LEGALWORK_ELECTRON__?.system?.importWorkdayFileHistory;
  const check = useMutation({
    mutationFn: () => chooseFolder!(date, t("timeWorkspace.historyFolder"), profileId),
    onSuccess: result => {
      if (result?.imported) void cache.invalidateQueries({
        predicate: query => query.queryKey[0] === "back-office" && query.queryKey.includes("workday"),
      });
    },
  });
  if (!chooseFolder) return null;
  const result = check.data;
  return <>
    <TimeSetting title={t("timeWorkspace.historyTitle")} description={t("timeWorkspace.historyHelp")}>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" aria-label={t("timeWorkspace.historyDate")} max={today} value={date}
          className="w-auto" disabled={disabled || check.isPending}
          onChange={event => { setDate(event.target.value); check.reset(); }} />
        <Button size="sm" variant="outline" disabled={disabled || check.isPending || !date || date > today}
          onClick={() => check.mutate()}>{t(check.isPending ? "timeWorkspace.historyChecking" : "timeWorkspace.historyFolder")}</Button>
      </div>
    </TimeSetting>
    {(check.isError || result) && <p className="px-5 py-3 text-xs text-muted-foreground" role="status">
      {check.isError ? t("timeWorkspace.historyError") : result?.matched
        ? t(result.matched === 1 ? "timeWorkspace.historySingle" : "timeWorkspace.historyResult", { matched: result.matched, imported: result.imported }) : t("timeWorkspace.historyEmpty")}
      {result?.limited && " " + t("timeWorkspace.historyLimited")}
    </p>}
  </>;
}
