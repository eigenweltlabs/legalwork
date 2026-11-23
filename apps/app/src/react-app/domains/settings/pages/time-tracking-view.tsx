import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, X } from "lucide-react";
import { captureAccountEnabled, workdaySchedule, type CaptureAction } from "@legalwork/types/time-capture";
import { TimesheetStateSchema } from "@legalwork/types/timesheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarDay } from "../../calendar/calendar-format";
import { calendarClientScope } from "../../calendar/calendar-cache";
import { timeTrackingProfile } from "../../back-office/time-tracking-profile";
import { sourceKeys } from "../../back-office/timesheet-labels";
import { TimeSettingsGroup, TimeSelect, TimeSetting, TimeSwitch } from "../../back-office/time-settings-controls";
import { TimeWorkspaceGuidelines } from "../../back-office/time-workspace-guidelines";
import { LayoutStack } from "../settings-layout";
import { DesktopActivitySetting } from "./desktop-activity-setting";

type SettingAction = Extract<CaptureAction, { type: "settings-patch" | "guideline" }>;

export function TimeTrackingSettingsView({ client }: { client: LegalworkServerClient | null }) {
  const [params] = useSearchParams();
  const cache = useQueryClient();
  const local = client && isLoopbackLegalworkServerUrl(client.baseUrl);
  const date = calendarDay(new Date());
  const directory = useQuery(timeTrackingProfile(client));
  const profile = directory.data;
  const identity = profile && { scope: profile.scope, user: profile.user, principal: profile.principal, profileId: profile.profileId };
  const key = ["back-office", ...calendarClientScope(client), "workday", profile?.directoryId, identity];
  const dayKey = [...key, "day", date];
  const day = useQuery({ queryKey: dayKey, enabled: Boolean(local && identity), retry: false,
    queryFn: ({ signal }) => client!.privateWorkday({ ...identity!, date }, undefined, signal) });
  const targets = useQuery({
    queryKey: ["time-tracking-settings", ...calendarClientScope(client), "targets", profile?.directoryId, identity], enabled: Boolean(local && profile && day.data && day.data.settings.enabled !== false), retry: false,
    queryFn: async () => {
      const params = new URLSearchParams({ expectedUserId: identity!.user });
      if (profile?.directoryId) params.set("directoryId", profile.directoryId);
      if (identity?.principal) params.set("expectedPrincipalKey", identity.principal);
      const result = TimesheetStateSchema.parse(await client!.backOffice("/timesheet?" + params, { team: profile?.scope !== "local" }));
      if (result.userId !== identity?.user || result.scope !== identity?.scope) throw new Error(t("timesheets.account_changed"));
      return result;
    },
  });
  const update = useMutation({
    mutationFn: async (action: SettingAction) => {
      if (!client || !profile || !identity) throw new Error(t("timesheets.account_changed"));
      const result = await client.privateWorkday({ ...identity, date }, action);
      return { result, profile, key, dayKey, profileKey: timeTrackingProfile(client).queryKey };
    },
    onSuccess: async ({ result, profile, key, dayKey, profileKey }) => {
      await cache.cancelQueries({ queryKey: key });
      cache.setQueryData(dayKey, result);
      cache.setQueryData(profileKey, current => current?.profileId === profile.profileId ? {
        ...current, enabled: result.settings.enabled !== false, desktopActivity: result.settings.desktopActivity === true, workspaceActivity: result.settings.workspaceActivity !== false,
      } : current);
      await cache.invalidateQueries({ queryKey: key });
    },
  });
  if (!local) return <p>{t("timesheets.local_only")}</p>;
  const error = directory.error || day.error;
  if (error) return <p role="alert">{error.message}</p>;
  if (!day.data || !profile || !identity) return <p role="status">{t("timesheets.loading")}</p>;
  const { settings, connections, guidelines } = day.data;
  const enabled = settings.enabled !== false;
  const schedule = workdaySchedule(settings);
  const pending = update.isPending;
  const change = (change: Extract<CaptureAction, { type: "settings-patch" }>["change"]) => update.mutate({ type: "settings-patch", change });
  const saveTimes = (times: string[]) => change({ field: "schedule", value: { frequency: "daily", times: [...times].sort() } });
  const directoryMatches = profile.directoryId && profile.directoryId === params.get("directory");
  const matter = directoryMatches && targets.data?.matters.find(item => item.id === params.get("matter"));
  const clientTarget = directoryMatches && targets.data?.clients.find(item => item.id === params.get("client"));
  const initialTarget = matter ? { scope: "matter" as const, targetId: matter.id } :
    clientTarget ? { scope: "client" as const, targetId: clientTarget.id } : undefined;
  return <LayoutStack>
    <TimeSettingsGroup>
      <TimeSwitch label={t("timeWorkspace.suggestionsEnabled")} description={t("timeWorkspace.suggestionsDescription")}
        checked={enabled} disabled={pending} onChange={value => change({ field: "enabled", value })} />
    </TimeSettingsGroup>
    {enabled && <>
      <TimeSettingsGroup title={t("timeWorkspace.scheduleTitle")}>
        <TimeSetting title={t("timeWorkspace.frequency")} description={t(schedule.frequency === "hourly" ? "timeWorkspace.hourlyHelp" : "timeWorkspace.dailyHelp")}>
          <TimeSelect label={t("timeWorkspace.frequency")} value={schedule.frequency} disabled={pending}
            options={[{ id: "hourly", name: t("timeWorkspace.hourly") }, { id: "daily", name: t("scheduled.daily") }]}
            onChange={frequency => { if (frequency === "hourly") change({ field: "schedule", value: { frequency } });
              if (frequency === "daily") saveTimes(["08:00", "20:00"]); }} />
        </TimeSetting>
        {schedule.frequency === "daily" && <TimeSetting title={t("timeWorkspace.runTimes")}>
          <ul className="grid gap-2" aria-label={t("timeWorkspace.runTimes")}>
            {schedule.times.map((time, index) => <li className="flex items-center gap-2" key={time}>
              <Input type="time" className="w-30" aria-label={t("timeWorkspace.runAt", { time })} disabled={pending}
                defaultValue={time} onBlur={event => {
                  const value = event.currentTarget.value;
                  if (value && value !== time && !schedule.times.includes(value))
                    saveTimes(schedule.times.map((old, n) => n === index ? value : old));
                  else event.currentTarget.value = time;
                }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              {schedule.times.length > 1 && <Button variant="ghost" size="icon-xs" disabled={pending}
                aria-label={t("timeWorkspace.removeTime", { time })} onClick={() => saveTimes(schedule.times.filter(value => value !== time))}><X /></Button>}
            </li>)}
            {schedule.times.length < 24 && <li><Button size="sm" variant="outline" disabled={pending} onClick={() => {
              const next = Array.from({ length: 24 }, (_, i) => String((8 + i) % 24).padStart(2, "0") + ":00").find(value => !schedule.times.includes(value));
              if (next) saveTimes([...schedule.times, next]);
            }}><Plus />{t("timeWorkspace.addTime")}</Button></li>}
          </ul>
        </TimeSetting>}
      </TimeSettingsGroup>
      <TimeSettingsGroup title={t("timesheets.sources")}>
        {(["calendar", "tasks", "documents", "workspaceActivity", "recordings"] as const).map(source => <TimeSwitch key={source}
          label={t(source === "workspaceActivity" ? "timeWorkspace.workspaceActivity" : sourceKeys[source])}
          description={source === "workspaceActivity" ? t("timeWorkspace.workspaceDescription") : source === "recordings" ? t("timesheets.source.recordingsDescription") : undefined}
          checked={source === "workspaceActivity" ? settings.workspaceActivity !== false : Boolean(settings[source])}
          disabled={pending} onChange={value => change({ field: source, value })} />)}
        <DesktopActivitySetting profileId={profile.profileId} checked={settings.desktopActivity === true} disabled={pending}
          onChange={value => change({ field: "desktopActivity", value })} />
        <TimeSetting title={t("timesheets.source.stopwatch")}>
          <TimeSelect label={t("timesheets.source.stopwatch")} disabled={pending} value={settings.stopwatchMode ?? "always"}
            options={[{ id: "always", name: t("timeWorkspace.timerAlways") }, { id: "evidence", name: t("timeWorkspace.timerEvidence") }]}
            onChange={value => { if (value === "always" || value === "evidence") change({ field: "stopwatchMode", value }); }} />
        </TimeSetting>
        {connections.map(account => <TimeSwitch key={account.provider + account.account}
          label={[t(sourceKeys[account.provider]), account.name].filter(Boolean).join(" · ")} checked={captureAccountEnabled(settings, account)} disabled={pending}
          onChange={value => change({ field: "account", account, value })} />)}
      </TimeSettingsGroup>
      <p className="text-sm text-muted-foreground">{t("timesheets.connector_context")}</p>
      <Link className="text-sm underline" to="/settings/extensions">{t("timesheets.connect_sources")}</Link>
    </>}
    {enabled && (targets.error ? <p role="alert">{targets.error.message}</p> : targets.data &&
      <TimeWorkspaceGuidelines key={JSON.stringify([identity, initialTarget])} initialTarget={initialTarget}
        date={date} guidelines={guidelines} state={targets.data} pending={pending}
        save={async action => { try { await update.mutateAsync(action); return true; } catch { return false; } }}
        extractRules={(text, signal) => client.privateGuidelineRules({ ...identity, date }, text, undefined, signal)}
        readPdf={(file, signal) => client.privateGuidelineText({ ...identity, date }, file, signal)} />)}
    {update.error && <p role="alert">{update.error.message}</p>}
  </LayoutStack>;
}
