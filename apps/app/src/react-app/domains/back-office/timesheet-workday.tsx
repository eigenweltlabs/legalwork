import { sourceKeys } from "./timesheet-labels";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { CalendarDays, Settings2, Sparkles, ChevronDown } from "lucide-react";
import { TimeSelect, TimeSetting, TimeSettingsGroup, TimeSwitch } from "./time-settings-controls";
import { LayoutStack } from "../settings/settings-layout";
import { Button } from "@/components/ui/button";
import type { TimeCaptureSheet } from "./time-record-sheet";
import { weekDates } from "./timesheet-row";
import {
  captureEnabled,
  sameCaptureAccount,
  type CaptureAction,
  type CaptureState,
  type CaptureProposal,
} from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import { t, currentLocale } from "@/i18n";
import { isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarDay } from "../calendar/calendar-format";
import { calendarClientScope } from "../calendar/calendar-cache";
import type { BackOfficeState } from "./api";
import { overlappingWorkdayRanges, WorkdayCorrectionForm, WorkdayTimeline } from "./timesheet-workday-view";
import "./timesheet-workday.css";

const at = (instant: string) =>
  new Date(instant).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
export function TimesheetWorkday({
  client,
  directory,
  state,
  onDraft,
  ledgerDirty = false,
  initialDate,
  onDateChange,
  children,
}: {
  children?: (capture: TimeCaptureSheet) => ReactNode;
  initialDate?: string;
  onDateChange?: (value: string) => void;
  client: LegalworkServerClient;
  directory: BackOfficeState;
  state: TimesheetState;
  ledgerDirty?: boolean;
  onDraft: (p: CaptureProposal) => void;
}) {
  const [editing, setEditing] = useState("");
  const [date, setDate] = useState(() => initialDate ?? calendarDay(new Date())),
    [error, setError] = useState(""),
    [running, setRunning] = useState(false);
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [showSuggestions, setShowSuggestions] = useState(true);
  const dates = period === "week" ? weekDates(date) : [date];
  const navigate = useNavigate(),
    cache = useQueryClient();
  useEffect(() => {
    if (initialDate) setDate(initialDate);
  }, [initialDate]);
  const local = isLoopbackLegalworkServerUrl(client.baseUrl);
  const context = {
    date: dates[0],
    scope: directory.scope,
    user: directory.permissions.userId,
    principal: directory.permissions.principalKey ?? "",
    ...(directory.captureProfileId ? { profileId: directory.captureProfileId } : {}),
  };
  const key = ["back-office", ...calendarClientScope(client), "workday", context, period];
  const query = useQuery<CaptureState>({
    queryKey: key,
    queryFn: async () => {
      const days = await Promise.all(dates.map(date => client.privateWorkday({ ...context, date })));
      return { ...days[0], proposals: days.flatMap(day => day.proposals), drafts: days.reduce<CaptureState["drafts"]>((all, day) => ({ ...all, ...day.drafts }), {}) };
    },
    enabled: local,
    retry: false,
    refetchInterval: 60000,
  });
  const profileId = directory.captureProfileId;
  const { data: lastStoppedId } = useQuery({
    queryKey: ["private-stopwatch", ...calendarClientScope(client), profileId],
    queryFn: () => client.privateStopwatch(undefined, profileId),
    select: (status) => status.lastStopped?.id,
    enabled: local && Boolean(profileId),
    retry: false,
    refetchInterval: 5000,
  });
  const refetchWorkday = query.refetch;
  useEffect(() => {
    if (local && profileId && lastStoppedId) void refetchWorkday();
  }, [local, profileId, lastStoppedId, refetchWorkday]);
  async function act(action: CaptureAction) {
    setError("");
    const foreground = action.type !== "draft";
    if (foreground) setRunning(true);
    try {
      const targetDate = action.type === "draft" && action.date ? action.date : "key" in action ? query.data?.proposals.find(proposal => proposal.key === action.key)?.date ?? query.data?.drafts[action.key]?.date ?? date : date;
      const next = await client.privateWorkday({ ...context, date: targetDate }, action);
      await cache.cancelQueries({ queryKey: key, exact: true });
      cache.setQueryData<CaptureState>(key, previous => {
        if (!dates.includes(targetDate)) return previous;
        if (!previous || period === "day") return next;
        return { ...next, proposals: [...previous.proposals.filter(proposal => proposal.date !== targetDate), ...next.proposals],
          drafts: { ...Object.fromEntries(Object.entries(previous.drafts).filter(([, draft]) => draft.date !== targetDate)), ...next.drafts } };
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("timesheets.unavailable"));
      return false;
    } finally {
      if (foreground) setRunning(false);
    }
  }

  const data = query.data,
    settings = data?.settings,
    shown =
      data?.proposals.filter(
        (p) =>
          !directory.records.some(record => record.objectId === "timeEntries" && record.id === p.key) &&
          !state.entries.some(
            (e) =>
              (e.groupId === p.key ||
                e.proposalDigest === p.digest ||
                (e.proposalDigest && p.versions?.includes(e.proposalDigest))) &&
              e.workerId === context.user,
          ),
      ) ?? [];
  const selected = shown.find((p) => p.key === editing);
  const bookedEntries = state.entries.filter(
    (e) =>
      e.workerId === context.user &&
      ["confirmed", "submitted", "approved", "invoiced"].includes(e.status),
  );
  const ownEntries = bookedEntries.filter(entry => entry.date === date);
  const ownRecords = directory.records.filter(record => {
    if (record.objectId !== "timeEntries" || record.archivedAt) return false;
    if (!record.values.timekeeper) return record.ownerId === context.user;
    const person = directory.records.find(person => person.objectId === "people" && person.id === record.values.timekeeper);
    return person?.sourceId === "eigenwelt-member:" + context.user && person.values.active !== false;
  });
  const recordsOnly = state.service === "records";
  const overlaps = overlappingWorkdayRanges(shown, recordsOnly ? ownRecords.flatMap(({ values }) =>
    typeof values.startedAt === "string" && values.startedAt.includes("T") && typeof values.endedAt === "string"
      ? [{ startAt: values.startedAt, endAt: values.endedAt }]
      : [],
  ) : bookedEntries);
  function selectDate(next: string) {
    if (!next || next === date) return;
    setDate(next);
    onDateChange?.(next);
  }
  return (
    <section className={"bo-workday" + (children ? " time-unified" : "")}>
      <div className="bo-workday-controls">
        <label>
          <CalendarDays size={14} />
          <input
            type="date"
            aria-label={t("timesheets.date")}
            value={date}
            onChange={(e) => selectDate(e.target.value)}
          />
        </label>
        <Button size="sm" variant="ghost" onClick={() => selectDate(calendarDay(new Date()))}>{t("timesheets.today")}</Button>
        {children && <div className="time-sheet-period">{(["day", "week"] as const).map(value => <Button key={value} size="xs" variant={period === value ? "secondary" : "ghost"} aria-pressed={period === value} onClick={() => setPeriod(value)}>{t(value === "day" ? "timesheets.ledger.day" : "timesheets.ledger.week")}</Button>)}</div>}
        <span className="bo-workday-toolbar-space" />
        {children && <Button size="sm" variant="ghost" aria-pressed={showSuggestions} onClick={() => setShowSuggestions(value => !value)}><Sparkles size={14} />{t("timesheets.sheet.suggestions", { count: shown.length })}</Button>}
        <Button
          size="sm"
          disabled={running || !settings || !captureEnabled(settings)}
          variant="outline"
          onClick={() => void act({ type: "calendar" })}
        >
          {t("timesheets.read_sources")}
        </Button>
        <Button
          size="sm"
          title={data?.modelReady ? undefined : t("timesheets.no_model")}
          disabled={running || !data?.modelReady || !settings || !captureEnabled(settings)}
          onClick={() => void act({ type: "run" })}
        >
          <Sparkles size={14} />
          {t("timesheets.run_local")}
        </Button>
      </div>
      <div className="time-sheet-tools">
      {settings && (
        <details>
          <summary>
            <Settings2 size={14} /><ChevronDown size={12} className="time-detail-chevron" />
            {t("timesheets.sources")}
          </summary>
          <LayoutStack className="mt-3">
            <TimeSettingsGroup>
              {(["calendar", "tasks", "documents"] as const).map((source) => {
                const label = t(sourceKeys[source]);
                return (
                  <TimeSwitch
                    key={source}
                    label={label}
                    checked={Boolean(settings[source])}
                    disabled={running}
                    onChange={(checked) =>
                      void act({ type: "settings", settings: { ...settings, [source]: checked } })
                    }
                  />
                );
              })}
              {data?.connections.map((account) => {
                const enabled =
                  settings.connections?.some((item) => sameCaptureAccount(item, account)) ?? false;
                return (
                  <TimeSwitch
                    key={account.provider + account.account}
                    label={t(sourceKeys[account.provider])}
                    disabled={running}
                    checked={enabled}
                    onChange={(checked) => {
                      const others = (settings.connections ?? []).filter(
                        (item) => !sameCaptureAccount(item, account),
                      );
                      void act({
                        type: "settings",
                        settings: {
                          ...settings,
                          connections: checked ? [...others, account] : others,
                        },
                      });
                    }}
                  />
                );
              })}
              <TimeSetting title={<label htmlFor="time-source-schedule">{t("timesheets.schedule")}</label>}>
                <TimeSelect
                  id="time-source-schedule"
                  label={t("timesheets.schedule")}
                  disabled={running || !data?.modelReady}
                  value={String(settings.intervalMinutes)}
                  options={[
                    { id: "0", name: t("timesheets.on_demand") },
                    ...[15, 30, 60].map((n) => ({ id: String(n), name: n + " min" })),
                  ]}
                  onChange={(value) => {
                    const interval = Number(value);
                    if (interval === 0 || interval === 15 || interval === 30 || interval === 60)
                      void act({ type: "settings", settings: { ...settings, intervalMinutes: interval } });
                  }}
                />
              </TimeSetting>
            </TimeSettingsGroup>
          </LayoutStack>
          <p>{t("timesheets.sources_hint")}</p>
          <div className="bo-workday-links">
            <Link to="/settings/extensions">{t("timesheets.connect_sources")}</Link>
            <Link to="/workflows">{t("timesheets.workflow_settings")}</Link>
          </div>
          {!data?.modelReady && <p>{t("timesheets.no_model")}</p>}
        </details>
      )}
      {data && (shown.some(p => p.date === date && p.startAt && p.endAt) || ownEntries.some(e => e.startAt && e.endAt)) && (
        <details className="bo-workday-timeline">
        <summary><CalendarDays size={14} /><ChevronDown size={12} className="time-detail-chevron" />{t("timesheets.timeline")}</summary>
        <WorkdayTimeline
          date={date}
          proposals={shown.filter(proposal => proposal.date === date)}
          state={state}
          confirmed={ownEntries}
          onOpen={(p) => setEditing(p.key)}
        />
        </details>
      )}
      </div>
      {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
      {running && <p role="status">{t("timesheets.preparing")}</p>}
      {selected && (
        <WorkdayCorrectionForm
          key={selected.digest}
          proposal={selected}
          state={state}
          pending={running}
          save={act}
          close={() => setEditing("")}
        />
      )}
      {children?.({ proposals: shown, showSuggestions, privateAvailable: Boolean(data), drafts: data?.drafts ?? {}, date, dates, overlaps, linkableRecords: ownRecords, selectDate, act, openSource: proposal => setEditing(proposal.key) })}
      {data && !children && (
        <div className="bo-workday-list">
          {!shown.length ? (
            <p className="bo-workday-empty">{t("timesheets.activity_empty")}</p>
          ) : (
            shown.map((p) => (
              <div className="bo-workday-row" key={p.key}>
                <time>
                  {p.startAt ? at(p.startAt) : t("timesheets.workday.no_clock")}
                  {p.endAt && " – " + at(p.endAt)}
                  <span className="bo-workday-duration">{p.workedMinutes === null ? "–" : p.workedMinutes + " min"}</span>
                </time>
                <span>
                  {p.source === "stopwatch" && !p.parentDigest
                    ? t("timesheets.source.stopwatch")
                    : p.narrative}
                  {overlaps.has(p.key) && <small>{t("timesheets.workday.overlap")}</small>}
                  <small>
                    {state.projects.find(project => project.id === p.projectId)?.name
                      || state.matters.find(matter => matter.id === p.matterId)?.name
                      || t("timesheets.project_missing")}
                    {" · "}{t(sourceKeys[p.source])}
                  </small>
                </span>
                <div>
                  <Button size="sm" variant="ghost" disabled={running} onClick={() => setEditing(p.key)}>
                    {t("timesheets.workday.correct")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    title={ledgerDirty ? t("timesheets.ledger.finish_edit") : undefined}
                    disabled={
                      !directory.permissions.edit ||
                      ledgerDirty ||
                      running ||
                      !!selected ||
                      overlaps.has(p.key)
                    }
                    onClick={() => {
                      onDraft(p);
                      navigate("/time?date=" + p.date);
                    }}
                  >
                    {t(recordsOnly ? "timesheets.prepare_record" : "timesheets.prepare_draft")}
                  </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={running}
                  onClick={() => void act({ type: "dismiss", key: p.key })}
                >
                  {t("timesheets.dismiss")}
                </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {data && ownEntries.some((e) => !e.startAt || !e.endAt) && (
        <details>
          <summary>{t("timesheets.workday.booked_without_clock")}</summary>
          {ownEntries
            .filter((e) => !e.startAt || !e.endAt)
            .map((e) => (
              <p key={e.id}>
                {e.workedMinutes} min · {e.narrative}
              </p>
            ))}
        </details>
      )}
    </section>
  );
}
