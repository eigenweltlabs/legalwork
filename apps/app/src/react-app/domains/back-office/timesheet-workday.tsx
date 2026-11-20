import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CalendarDays, Settings, Sparkles, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  captureAccountEnabled, localWorkdayModel, sameCaptureAccount,
  type CaptureAction, type CaptureState, type WorkdayModelOption, type CaptureProposal,
} from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarDay } from "../calendar/calendar-format";
import { calendarClientScope } from "../calendar/calendar-cache";
import { LayoutStack } from "../settings/settings-layout";
import type { BackOfficeState } from "./api";
import type { TimeCaptureSheet } from "./time-record-sheet";
import { TimeSelect, TimeSetting, TimeSettingsGroup, TimeSwitch } from "./time-settings-controls";
import { TimeWorkspacePanels } from "./time-workspace-panels";
import { TimeWorkspaceChat } from "./time-workspace-chat";
import { TimeWorkspaceGuidelines } from "./time-workspace-guidelines";
import { TimeWorkspaceStopwatch, useTimeWorkspaceStopwatch } from "./time-workspace-stopwatch";
import { TimesheetPeriodSwitch } from "./timesheet-week-totals";
import { adjacentPeriod, periodDates, type TimePeriod } from "./timesheet-row";
import { sourceKeys } from "./timesheet-labels";
import { overlappingWorkdayRanges, proposalTitle, WorkdayCorrectionForm, WorkdayTimeline } from "./timesheet-workday-view";
import "./timesheet-workday.css";

export type RenderTimeWorkspace = (entries: ReactNode, renderProposal: (proposal: CaptureProposal) => ReactNode) => ReactNode;

export function TimesheetWorkday({
  client, directory, state, dateLocked = false, visible = true,
  initialDate, models = [], onDateChange, children,
}: {
  children: (capture: TimeCaptureSheet, workspace: RenderTimeWorkspace) => ReactNode;
  initialDate?: string;
  models?: WorkdayModelOption[];
  onDateChange: (value: string) => void;
  client: LegalworkServerClient;
  directory: BackOfficeState;
  state: TimesheetState;
  dateLocked?: boolean;
  visible?: boolean;
}) {
  const [date, setDate] = useState(() => initialDate ?? calendarDay(new Date()));
  const [period, setPeriod] = useState<TimePeriod>("day");
  const [selection, setSelection] = useState<string>();
  const [correction, setCorrection] = useState<CaptureProposal>();
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const modelRequest = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef(false);
  const cache = useQueryClient();
  const dates = periodDates(date, period);
  useEffect(() => { if (initialDate) setDate(initialDate); }, [initialDate]);
  useLayoutEffect(() => {
    if (selection) editor.current?.scrollIntoView({ block: "nearest" });
  }, [selection, correction?.key]);

  const local = isLoopbackLegalworkServerUrl(client.baseUrl);
  const profileId = directory.captureProfileId;
  const identity = {
    scope: directory.scope,
    user: directory.permissions.userId,
    principal: directory.permissions.principalKey ?? "",
    ...(profileId ? { profileId } : {}),
  };
  const scopeKey = ["back-office", ...calendarClientScope(client), "workday", directory.directoryId, identity];
  const dayKey = (target: string) => [...scopeKey, "day", target];
  const workday = useQuery({
    queryKey: dayKey(date), enabled: local && visible, retry: false, refetchInterval: 60000,
    queryFn: ({ signal }) => client.privateWorkday({ ...identity, date }, undefined, signal),
  });
  const otherDays = dates.filter(day => day !== date);
  const overview = useQuery({
    queryKey: [...scopeKey, "overview", otherDays],
    enabled: local && visible && otherDays.length > 0, retry: false,
    queryFn: async ({ signal }) => {
      const drafts: CaptureState["drafts"] = {};
      for (let i = 0; i < otherDays.length; i += 7) {
        signal.throwIfAborted();
        const days = await Promise.all(otherDays.slice(i, i + 7).map(
          target => client.privateWorkday({ ...identity, date: target }, undefined, signal),
        ));
        for (const day of days) Object.assign(drafts, day.drafts);
      }
      return drafts;
    },
  });
  const stopwatch = useTimeWorkspaceStopwatch(client, profileId, local && visible);
  const lastStopped = stopwatch.data?.lastStopped;
  const stoppedId = lastStopped?.date === date ? lastStopped.id : undefined;
  const lastStoppedId = lastStopped?.id;
  const refetchWorkday = workday.refetch;
  useEffect(() => {
    if (visible && local && lastStoppedId) void refetchWorkday();
  }, [visible, local, lastStoppedId, refetchWorkday]);

  const data = workday.data;
  const settings = data?.settings;
  const drafts = { ...overview.data, ...data?.drafts };
  const aiEnabled = settings?.aiSuggestions === true;
  const modelKey = (item: { providerID: string; modelID: string }) => JSON.stringify([item.providerID, item.modelID]);
  const preferred = settings?.model;
  const modelOptions = [
    ...models.filter(item => modelKey(item) !== modelKey(localWorkdayModel)),
    ...(data?.modelReady ? [{ ...localWorkdayModel, label: t("timeWorkspace.localModel") }] : []),
  ];
  const automatic = ["haiku", "luna"].map(name => modelOptions.find(item => item.providerID === "eigenwelt" &&
    (item.label + " " + item.modelID).toLowerCase().includes(name))).find(Boolean);
  const selectedModel = preferred ? modelOptions.find(item => modelKey(item) === modelKey(preferred)) : automatic;
  const model = selectedModel && { workspaceId: selectedModel.workspaceId, providerID: selectedModel.providerID, modelID: selectedModel.modelID };
  const modelSelection = JSON.stringify([preferred, model]);
  useEffect(() => {
    return () => { modelRequest.current?.abort(); };
  }, [date, modelSelection, visible, aiEnabled]);

  async function act(action: CaptureAction, signal?: AbortSignal) {
    const foreground = action.type !== "draft" && action.type !== "refresh";
    if (foreground && inFlight.current) return false;
    if (foreground) {
      inFlight.current = true;
      setRunning(true);
    }
    setError("");
    const target = action.type === "draft" ? action.date ?? drafts[action.key]?.date ?? date : date;
    const key = dayKey(target);
    try {
      const next = await client.privateWorkday({ ...identity, date: target }, action, signal);
      if (signal?.aborted) return false;
      if (action.type === "settings") {
        await cache.cancelQueries({ queryKey: scopeKey });
        cache.setQueriesData<CaptureState>({ queryKey: [...scopeKey, "day"] }, previous =>
          previous && { ...previous, settings: next.settings, connections: next.connections, proposals: [] });
      } else {
        await cache.cancelQueries({ queryKey: key, exact: true });
      }
      if (signal?.aborted) return false;
      cache.setQueryData<CaptureState>(key, previous => {
        if (!previous || action.type !== "draft") return next;
        const drafts = { ...previous.drafts };
        const updated = next.drafts[action.key];
        if (updated) drafts[action.key] = updated;
        else delete drafts[action.key];
        return { ...previous, drafts };
      });
      if (action.type === "draft" && target !== date) {
        void cache.invalidateQueries({ queryKey: [...scopeKey, "overview"] });
      } else if (action.type === "settings") {
        await cache.invalidateQueries({ queryKey: [...scopeKey, "day"] });
      }
      return true;
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : t("timesheets.unavailable"));
      return false;
    } finally {
      if (foreground) {
        inFlight.current = false;
        setRunning(false);
      }
    }
  }

  const refreshKey = visible && local && aiEnabled && settings
    ? JSON.stringify([date, settings, model, data?.modelReady, stoppedId])
    : null;
  const prepareView = useEffectEvent(async (signal: AbortSignal) => {
    setRefreshing(true);
    try { await act({ type: "refresh", model }, signal); }
    finally { if (!signal.aborted) setRefreshing(false); }
  });
  useEffect(() => {
    setRefreshing(false);
    if (!refreshKey) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void prepareView(controller.signal); });
    return () => controller.abort();
  }, [refreshKey]);

  async function requestModel(action: Extract<CaptureAction, { type: "chat" | "instruction" }> | { type: "suggest" }) {
    if (action.type === "instruction" || (action.type === "chat" && action.instruction)) return act(action);
    if (inFlight.current) return false;
    const controller = new AbortController();
    modelRequest.current = controller;
    try { return await act({ ...action, model }, controller.signal); }
    finally { if (modelRequest.current === controller) modelRequest.current = undefined; }
  }
  const shown = data?.proposals.filter(p =>
    p.date === date && !p.dismissed && (aiEnabled || (p.source === "stopwatch" && !p.suggested)) &&
    !directory.records.some(record => record.objectId === "timeEntries" && record.id === p.key) &&
    !state.entries.some(e => e.workerId === identity.user && (
      e.groupId === p.key || e.proposalDigest === p.digest ||
      (e.proposalDigest && p.versions?.includes(e.proposalDigest))
    )),
  ) ?? [];
  const selected = shown.find(proposal => proposal.key === selection);
  const ownContactIds = new Set(directory.records.filter(person =>
    person.objectId === "people" && !person.archivedAt && person.values.active !== false &&
    person.sourceId === "eigenwelt-member:" + identity.user,
  ).map(person => person.id));
  const confirmed = state.entries.filter(entry => entry.workerId === identity.user &&
    entry.status !== "pending" && entry.status !== "declined");
  const ownEntries = new Set(confirmed.map(entry => entry.id));
  const ownRecords = directory.records.filter(record => {
    if (record.objectId !== "timeEntries" || record.archivedAt) return false;
    if (state.service !== "records") return ownEntries.has(record.id);
    const timekeeper = record.values.timekeeper;
    if (!timekeeper) return record.ownerId === identity.user;
    return typeof timekeeper === "string" && ownContactIds.has(timekeeper);
  });
  const booked = state.service === "records" ? ownRecords.flatMap(({ values }) =>
    typeof values.startedAt === "string" && values.startedAt.includes("T") && typeof values.endedAt === "string"
      ? [{ startAt: values.startedAt, endAt: values.endedAt }] : [],
  ) : confirmed;
  const overlaps = overlappingWorkdayRanges(shown, booked);
  function selectDate(next: string, openDay = false) {
    if (!next || (next === date && !openDay)) return;
    if (dateLocked && next !== date) {
      setError(t("timesheets.ledger.finish_edit"));
      return;
    }
    setError("");
    if (openDay) setPeriod("day");
    if (next !== date) {
      setSelection(undefined);
      setCorrection(undefined);
      setDate(next);
      onDateChange(next);
    }
  }
  const capture: TimeCaptureSheet = {
    proposals: shown, wording: data?.wording, privateAvailable: Boolean(data), drafts, date, dates,
    overlaps, linkableRecords: ownRecords, selectDate, act,
    openSource: setCorrection,
  };
  const renderWorkspace: RenderTimeWorkspace = (entries, renderProposal) => (
    <TimeWorkspacePanels scope={JSON.stringify([client.baseUrl, directory.directoryId, identity])}
      entries={entries}
      chat={<TimeWorkspaceChat key={date} data={data} state={state} proposals={shown}
        pending={running} aiEnabled={aiEnabled} onAction={requestModel} />}
      timeline={(view, choose) => (
        <>
          <div className="time-workspace-private-toolbar">
            {local && <TimeSelect label={t("timeWorkspace.timelineView")} value={view} options={[
              { id: "combined", name: t("timeWorkspace.combined") }, { id: "matters", name: t("timeWorkspace.byMatter") },
            ]} onChange={value => {
              if (value === "combined" || value === "matters") choose(value);
            }} />}
          </div>
          {!local && <p className="time-workspace-note">{t("timesheets.local_only")}</p>}
          {selected && (
            <div ref={editor} className="time-workspace-editor">
              <header>
                <h3>{proposalTitle(selected)}</h3>
                <Button size="icon-xs" variant="ghost" aria-label={t("timesheets.workday.cancel")} onClick={() => {
                  setSelection(undefined);
                  setCorrection(undefined);
                }}><X size={14} /></Button>
              </header>
              <p className="time-workspace-note">{t(sourceKeys[selected.source])}
                {selected.observation === "foreground" && " · " + t("timeWorkspace.foreground")}
                {selected.observation === "passive" && " · " + t("timeWorkspace.passive")}
              </p>
              {correction?.digest === selected.digest
                ? <WorkdayCorrectionForm key={selected.digest} proposal={correction} state={state}
                  pending={running} save={act} close={() => setCorrection(undefined)} />
                : renderProposal(selected)}
            </div>
          )}
          {local && (
            <>
              {data && shown.length === 0 && <p className="time-workspace-note">{t("timeWorkspace.noSuggestions")}</p>}
              <WorkdayTimeline date={date} proposals={shown} state={state} view={view} selected={selection} onOpen={proposal => {
                setCorrection(undefined);
                setSelection(proposal.key);
              }} />
            </>
          )}
        </>
      )}
    />
  );
  const status = data?.status;
  return (
    <section className="bo-workday time-unified">
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
        <TimesheetPeriodSwitch period={period} onChange={setPeriod} />
        <span className="bo-workday-toolbar-space" />
        {local && profileId && <TimeWorkspaceStopwatch key={profileId} stopwatch={stopwatch} />}
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
                  description={!selectedModel && !data?.modelReady ? t("timesheets.no_model") : undefined}>
                  <TimeSelect label={t("timesheets.ai_model")} value={preferred ? modelKey(preferred) : "auto"}
                    disabled={running} options={[
                      { id: "auto", name: [t("timesheets.ai_automatic"), automatic?.label].filter(Boolean).join(" · ") },
                      ...(preferred && !selectedModel ? [{ id: modelKey(preferred), name: preferred.modelID }] : []),
                      ...modelOptions.map(item => ({ id: modelKey(item), name: item.label })),
                    ]} onChange={value => {
                      const choice = modelOptions.find(item => modelKey(item) === value);
                      void act({ type: "settings", settings: { ...settings,
                        model: choice && { workspaceId: choice.workspaceId, providerID: choice.providerID, modelID: choice.modelID } } });
                    }} />
                </TimeSetting>
              </TimeSettingsGroup>
              <TimeSettingsGroup title={t("timesheets.sources")}>
                {(["calendar", "tasks", "documents", "workspaceActivity"] as const).map((source) => {
                  const label = t(source === "workspaceActivity" ? "timeWorkspace.workspaceActivity" : sourceKeys[source]);
                  return (
                    <TimeSwitch
                      key={source}
                      label={label}
                      checked={source === "workspaceActivity" ? settings.workspaceActivity !== false : Boolean(settings[source])}
                      disabled={running}
                      onChange={(checked) =>
                        void act({ type: "settings", settings: { ...settings, [source]: checked } })
                      }
                    />
                  );
                })}
                <TimeSetting title={t("timesheets.source.stopwatch")}>
                  <TimeSelect label={t("timesheets.source.stopwatch")} disabled={running} value={settings.stopwatchMode ?? "always"}
                    options={[
                      { id: "always", name: t("timeWorkspace.timerAlways") },
                      { id: "evidence", name: t("timeWorkspace.timerEvidence") },
                    ]}
                    onChange={value => {
                      if (value === "always" || value === "evidence")
                        void act({ type: "settings", settings: { ...settings, stopwatchMode: value } });
                    }} />
                </TimeSetting>
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
                    disabled={running || (!data?.modelReady && !selectedModel) || !aiEnabled}
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
          {data?.guidelines && <TimeWorkspaceGuidelines key={date} date={date} guidelines={data.guidelines}
            state={state} pending={running} save={act}
            readPdf={(file, signal) => client.privateGuidelineText({ ...identity, date }, file, signal)} />}
          <p className="time-workspace-note">{t("timesheets.sources_hint")}</p>
          <div className="bo-workday-links">
            <Link to="/settings/extensions">{t("timesheets.connect_sources")}</Link>
            <Link to="/workflows">{t("timesheets.workflow_settings")}</Link>
          </div>
          </PopoverContent>}
        </Popover>
      </div>
      {(error || workday.error || overview.error) && <p className="time-workspace-status" role="alert">
        {error || workday.error?.message || overview.error?.message}
        {workday.error && <Button variant="ghost" size="xs" onClick={() => void workday.refetch()}>{t("timesheets.retry")}</Button>}
        {overview.error && <Button variant="ghost" size="xs" onClick={() => void overview.refetch()}>{t("timesheets.retry")}</Button>}
      </p>}
      {refreshing ? <p className="time-workspace-status" role="status">{t("timesheets.preparing")}</p> : aiEnabled && status && (
        <p className="time-workspace-status" role="status">
          {t(status.type === "ready" ? "timeWorkspace.ready" : status.type === "unavailable" ? "timeWorkspace.unavailable" : "timeWorkspace.failed")}
          {status.type !== "ready" && <Button variant="ghost" size="xs" disabled={running}
            onClick={() => void requestModel({ type: "suggest" })}>{t("timesheets.retry")}</Button>}
        </p>
      )}
      {aiEnabled && !refreshing && !status && error && <Button variant="ghost" size="xs" className="time-workspace-status"
        disabled={running} onClick={() => void requestModel({ type: "suggest" })}>{t("timesheets.retry")}</Button>}
      {children(capture, renderWorkspace)}
    </section>
  );
}
