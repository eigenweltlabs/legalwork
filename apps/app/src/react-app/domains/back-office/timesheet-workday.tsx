import { sourceKeys } from "./timesheet-labels";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { CalendarDays, Settings, Sparkles, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TimeSelect, TimeSetting, TimeSettingsGroup, TimeSwitch } from "./time-settings-controls";
import { LayoutStack } from "../settings/settings-layout";
import { Button } from "@/components/ui/button";
import type { TimeCaptureSheet } from "./time-record-sheet";
import { adjacentPeriod, periodDates, periodLabels, timePeriods, type TimePeriod } from "./timesheet-row";
import {
  captureEnabled,
  captureAccountEnabled,
  sameCaptureAccount,
  type CaptureAction,
  type CaptureState,
  type WorkdayModelOption,
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
  visible = true,
  initialDate,
  models = [],
  onDateChange,
  children,
}: {
  children?: (capture: TimeCaptureSheet) => ReactNode;
  initialDate?: string;
  models?: WorkdayModelOption[];
  onDateChange?: (value: string) => void;
  client: LegalworkServerClient;
  directory: BackOfficeState;
  state: TimesheetState;
  ledgerDirty?: boolean;
  visible?: boolean;
  onDraft: (p: CaptureProposal) => void;
}) {
  const [editing, setEditing] = useState("");
  const [date, setDate] = useState(() => initialDate ?? calendarDay(new Date())),
    [error, setError] = useState(""),
    [running, setRunning] = useState(false);
  const [period, setPeriod] = useState<TimePeriod>("day");
  const [wording, setWording] = useState<CaptureState["wording"]>();
  const [runResult, setRunResult] = useState<{ date: string; count: number }>();
  const [refreshing, setRefreshing] = useState(false);
  const dates = periodDates(date, period);
  const navigate = useNavigate(),
    cache = useQueryClient();
  useEffect(() => {
    if (initialDate) setDate(initialDate);
  }, [initialDate]);
  const local = isLoopbackLegalworkServerUrl(client.baseUrl);
  const identity = {
    scope: directory.scope,
    user: directory.permissions.userId,
    principal: directory.permissions.principalKey ?? "",
    ...(directory.captureProfileId ? { profileId: directory.captureProfileId } : {}),
  };
  const queryPrefix = ["back-office", ...calendarClientScope(client), "workday"];
  const scopeKey = [...queryPrefix, identity];
  const key = [...queryPrefix, { ...identity, date: dates[0] }, period];
  const query = useQuery<CaptureState>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const days: CaptureState[] = [];
      for (let i = 0; i < dates.length; i += 7) {
        signal.throwIfAborted();
        days.push(...await Promise.all(dates.slice(i, i + 7).map(date => client.privateWorkday({ ...identity, date }, undefined, signal))));
      }
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
  async function act(action: CaptureAction, signal?: AbortSignal) {
    setError("");
    const foreground = action.type !== "draft" && action.type !== "refresh";
    if (foreground) setRunning(true);
    try {
      const targetDate = action.type === "draft" && action.date ? action.date : "key" in action ? query.data?.proposals.find(proposal => proposal.key === action.key)?.date ?? query.data?.drafts[action.key]?.date ?? date : date;
      const { wording: generated, ...next } = await client.privateWorkday({ ...identity, date: targetDate }, action, signal);
      if (signal?.aborted) return false;
      if (action.type === "refresh") {
        setWording(generated);
        setRunResult(generated && { date: targetDate, count: Object.keys(generated).length });
      }
      if (action.type === "settings" || action.type === "calendar") {
        setWording(undefined);
        setRunResult(undefined);
      }
      if (action.type === "settings") {
        await cache.cancelQueries({ queryKey: scopeKey });
        // Settings apply to every day in this profile. Retire the cached suggestions
        // until the server returns the eligible sources for each visible date.
        cache.setQueriesData<CaptureState>({ queryKey: scopeKey }, previous =>
          previous && { ...previous, settings: next.settings, connections: next.connections, proposals: [] });
      } else {
        await cache.cancelQueries({ queryKey: key, exact: true });
      }
      cache.setQueryData<CaptureState>(key, previous => {
        if (!dates.includes(targetDate)) return previous;
        if (previous && action.type === "draft") {
          if (action.proposalDigest && !previous.proposals.some(proposal => proposal.key === action.key && proposal.digest === action.proposalDigest))
            return previous;
          const drafts = { ...previous.drafts };
          const updated = next.drafts[action.key];
          if (updated) drafts[action.key] = updated;
          else delete drafts[action.key];
          return { ...previous, drafts };
        }
        if (!previous || period === "day") return next;
        return { ...next, proposals: [...previous.proposals.filter(proposal => proposal.date !== targetDate), ...next.proposals],
          drafts: { ...Object.fromEntries(Object.entries(previous.drafts).filter(([, draft]) => draft.date !== targetDate)), ...next.drafts } };
      });
      if (action.type === "settings") await cache.invalidateQueries({ queryKey: scopeKey });
      return true;
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : t("timesheets.unavailable"));
      return false;
    } finally {
      if (foreground) setRunning(false);
    }
  }

  const data = query.data, settings = data?.settings;
  const aiEnabled = settings?.aiSuggestions === true;
  const modelKey = (item: { providerID: string; modelID: string }) => JSON.stringify([item.providerID, item.modelID]);
  const preferred = settings?.model;
  const eigenwelt = models.filter(item => item.providerID === "eigenwelt");
  const automatic = ["haiku", "luna"].map(name => eigenwelt.find(item =>
    (item.label + " " + item.modelID).toLowerCase().includes(name))).find(Boolean);
  const selectedModel = preferred ? models.find(item => modelKey(item) === modelKey(preferred)) : automatic;
  const model = selectedModel && { workspaceId: selectedModel.workspaceId, providerID: selectedModel.providerID, modelID: selectedModel.modelID };
  const refreshKey = visible && local && aiEnabled && settings && captureEnabled(settings, data?.connections)
    ? JSON.stringify([identity, date, period, settings, aiEnabled ? model : null, aiEnabled && data?.modelReady])
    : null;
  const prepareView = useEffectEvent(async (signal: AbortSignal) => {
    setRefreshing(true);
    try { await act({ type: "refresh", model: aiEnabled ? model : undefined }, signal); }
    finally { if (!signal.aborted) setRefreshing(false); }
  });
  useEffect(() => {
    setWording(undefined);
    setRunResult(undefined);
    setRefreshing(false);
    if (!refreshKey) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void prepareView(controller.signal); });
    return () => controller.abort();
  }, [refreshKey]);

  const shown = data?.proposals.filter(
        (p) =>
          (aiEnabled || p.source === "stopwatch") &&
          !directory.records.some(record => record.objectId === "timeEntries" && record.id === p.key) &&
          !state.entries.some(
            (e) =>
              (e.groupId === p.key ||
                e.proposalDigest === p.digest ||
                (e.proposalDigest && p.versions?.includes(e.proposalDigest))) &&
              e.workerId === identity.user,
          ),
      ) ?? [];
  const selected = shown.find((p) => p.key === editing);
  const bookedEntries = state.entries.filter(
    (e) =>
      e.workerId === identity.user &&
      ["confirmed", "submitted", "approved", "invoiced"].includes(e.status),
  );
  const ownEntries = bookedEntries.filter(entry => entry.date === date);
  const ownContactIds = new Set(directory.records.filter(person =>
    person.objectId === "people" && !person.archivedAt && person.values.active !== false &&
    person.sourceId === "eigenwelt-member:" + identity.user,
  ).map(person => person.id));
  const ownRecords = directory.records.filter(record => {
    if (record.objectId !== "timeEntries" || record.archivedAt) return false;
    const timekeeper = record.values.timekeeper;
    if (!timekeeper) return record.ownerId === identity.user;
    return typeof timekeeper === "string" && ownContactIds.has(timekeeper);
  });
  const recordsOnly = state.service === "records";
  const overlaps = overlappingWorkdayRanges(shown, recordsOnly ? ownRecords.flatMap(({ values }) =>
    typeof values.startedAt === "string" && values.startedAt.includes("T") && typeof values.endedAt === "string"
      ? [{ startAt: values.startedAt, endAt: values.endedAt }]
      : [],
  ) : bookedEntries);
  function selectDate(next: string) {
    if (!next || next === date) return;
    if (ledgerDirty) {
      setError(t("timesheets.ledger.finish_edit"));
      return;
    }
    setError("");
    setDate(next);
    onDateChange?.(next);
  }
  return (
    <section className={"bo-workday" + (children ? " time-unified" : "")}>
      <div className="bo-workday-controls">
        <div className="time-sheet-period">
          <Button size="icon-sm" variant="ghost" aria-label={t(period === "month" ? "calendar.previous" : period === "week" ? "calendar.previous_week" : "calendar.previous_day")}
            onClick={() => selectDate(adjacentPeriod(date, period, -1))}><ChevronLeft size={16} /></Button>
          <label>
            <CalendarDays size={14} />
            <input
              type="date"
              aria-label={t("timesheets.date")}
              value={date}
              onChange={(e) => selectDate(e.target.value)}
            />
          </label>
          <Button size="icon-sm" variant="ghost" aria-label={t(period === "month" ? "calendar.next" : period === "week" ? "calendar.next_week" : "calendar.next_day")}
            onClick={() => selectDate(adjacentPeriod(date, period, 1))}><ChevronRight size={16} /></Button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => selectDate(calendarDay(new Date()))}>{t("timesheets.today")}</Button>
        {children && <div className="time-sheet-period">{timePeriods.map(value => <Button key={value} size="xs" variant={period === value ? "secondary" : "ghost"} aria-pressed={period === value} onClick={() => setPeriod(value)}>{t(periodLabels[value])}</Button>)}</div>}
        <span className="bo-workday-toolbar-space" />
        <Button size="sm" variant={aiEnabled ? "secondary" : "outline"} role="switch"
          aria-label={t("timesheets.ai_tab")} aria-checked={aiEnabled} disabled={running || !settings}
          onClick={() => settings && void act({ type: "settings", settings: { ...settings, aiSuggestions: !aiEnabled } })}>
          <Sparkles size={14} />{t("timesheets.ai_tab")} · {t(aiEnabled ? "common.on" : "common.off")}
        </Button>
        <Popover>
          <PopoverTrigger render={<Button type="button" size="icon-sm" variant="ghost" disabled={!settings} aria-label={t("timesheets.ai_settings")} />}>
            <Settings size={16} />
          </PopoverTrigger>
          {settings && <PopoverContent align="end" className="w-[min(26rem,92vw)] max-h-[75vh] overflow-y-auto">
            <LayoutStack>
              <TimeSettingsGroup title={t("timesheets.ai_settings")}>
                <TimeSetting title={t("timesheets.ai_model")}
                  description={!model && !data?.modelReady ? t("timesheets.no_model") : undefined}>
                  <TimeSelect label={t("timesheets.ai_model")} value={preferred ? modelKey(preferred) : "auto"}
                    disabled={running} options={[
                      { id: "auto", name: [t("timesheets.ai_automatic"), automatic?.label].filter(Boolean).join(" · ") },
                      ...(preferred && !selectedModel ? [{ id: modelKey(preferred), name: preferred.modelID }] : []),
                      ...models.map(item => ({ id: modelKey(item), name: item.label })),
                    ]} onChange={value => {
                      const choice = models.find(item => modelKey(item) === value);
                      void act({ type: "settings", settings: { ...settings,
                        model: choice && { providerID: choice.providerID, modelID: choice.modelID } } });
                    }} />
                </TimeSetting>
              </TimeSettingsGroup>
              <TimeSettingsGroup title={t("timesheets.sources")}>
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
                  const enabled = captureAccountEnabled(settings, account);
                  return (
                    <TimeSwitch
                      key={account.provider + account.account}
                      label={t(sourceKeys[account.provider])}
                      disabled={running}
                      checked={enabled}
                      onChange={(checked) => {
                        const list = settings.connections ?? settings.disabledConnections ?? [];
                        const others = list.filter(item => !sameCaptureAccount(item, account));
                        const selection = settings.connections
                          ? { connections: checked ? [...others, account] : others }
                          : { disabledConnections: checked ? others : [...others, account] };
                        void act({ type: "settings", settings: { ...settings, ...selection } });
                      }}
                    />
                  );
                })}
                <TimeSetting title={<label htmlFor="time-source-schedule">{t("timesheets.schedule")}</label>}>
                  <TimeSelect
                    id="time-source-schedule"
                    label={t("timesheets.schedule")}
                    disabled={running || !data?.modelReady || !aiEnabled}
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
          </PopoverContent>}
        </Popover>
      </div>
      {!local && <small>{t("timesheets.local_only")}</small>}
      <div className="time-sheet-tools">
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
      {aiEnabled && !running && runResult?.date === date && <p role="status">{t("timesheets.run_result", { count: runResult.count })}</p>}
      {(running || refreshing) && <p role="status">{t("timesheets.preparing")}</p>}
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
      {children?.({ proposals: shown, wording: aiEnabled ? wording : undefined, privateAvailable: Boolean(data), drafts: data?.drafts ?? {}, date, dates, overlaps, linkableRecords: ownRecords, selectDate, act, openSource: proposal => setEditing(proposal.key) })}
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
