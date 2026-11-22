import { ItemDetailLabel, ItemDialogContent } from "@/react-app/design-system/item-detail";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sourceKeys } from "./timesheet-labels";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, ChevronLeft, ChevronRight, CalendarClock } from "lucide-react";
import { WorkdaySuggestionFeedback } from "./workday-suggestion-feedback";
import { WorkdayCoverage } from "./workday-coverage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type CaptureAction, type CaptureState, type PrivateDraftPatch, type CaptureProposal,
} from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarDay } from "../calendar/calendar-format";
import { calendarClientScope } from "../calendar/calendar-cache";
import type { BackOfficeState } from "./api";
import type { TimeCaptureSheet } from "./time-record-sheet";
import { TimeSelect } from "./time-settings-controls";
import { TimeHeaderContent, TimekeeperControlTarget, WorkspaceHeaderTarget } from "./time-workspace-header";
import { TimeWorkspacePanels } from "./time-workspace-panels";
import { TimeWorkspaceChat } from "./time-workspace-chat";
import { TimeWorkspaceStopwatch, useTimeWorkspaceStopwatch } from "./time-workspace-stopwatch";
import { TimesheetPeriodSwitch } from "./timesheet-week-totals";
import { adjacentPeriod, periodDates, type TimePeriod } from "./timesheet-row";
import { workdayProposalDisplay, WorkdayCorrectionForm, WorkdayTimeline } from "./timesheet-workday-view";
import { DirectProposalDecisionContext, type DirectProposalDecision, type ProposalDecision } from "./time-proposal-actions";
import "./timesheet-workday.css";

export type RenderTimeWorkspace = (
  entries: ReactNode,
  renderProposal: (proposal: CaptureProposal) => ReactNode,
  proposals?: CaptureProposal[],
) => ReactNode;

const suggestionFailureKeys = {
  timeout: "timeWorkspace.suggestionsTimedOut",
  invalid_output: "timeWorkspace.suggestionsInvalid",
  model_unavailable: "timeWorkspace.unavailable",
  provider_failed: "timeWorkspace.suggestionsModelFailed",
  sources_failed: "timeWorkspace.suggestionsSourcesFailed",
} as const;

function SuggestionFailure({ status }: { status: NonNullable<CaptureState["status"]> }) {
  if (status.type === "ready") return null;
  const sources = status.failedSources?.map(item => t(sourceKeys[item.provider]) + (item.name ? " (" + item.name + ")" : "")).join(", ");
  const fallback = status.type === "unavailable" ? "timeWorkspace.unavailable" : "timeWorkspace.failed";
  const reason = status.reason ? suggestionFailureKeys[status.reason] : undefined;
  // Older runs have no reason code. Preserve named source failures without
  // guessing what happened from the server's free-text message.
  const showReason = !sources || (status.reason ? status.reason !== "sources_failed" : status.type === "unavailable");
  return <div className="time-workspace-note" role="alert">
    {sources && <p>{t("timeWorkspace.sourcesFailed", { sources })}</p>}
    {showReason && <p>{t(reason ?? fallback)}</p>}
  </div>;
}

function CommitProposalFocus({ apply }: { apply: () => void }) {
  // Records mode can acknowledge a booking and update the panel before the
  // directory query updates the enclosing workday.
  useLayoutEffect(apply);
  return null;
}

export function TimesheetWorkday({
  client, directory, state, dateLocked = false, visible = true,
  initialDate, initialPeriod, onDateChange, children, invoices, requestedTab,
}: {
  children: (capture: TimeCaptureSheet, workspace: RenderTimeWorkspace) => ReactNode;
  initialDate?: string;
  initialPeriod?: TimePeriod;
  onDateChange: (value: string, period?: TimePeriod) => void;
  invoices?: ReactNode;
  requestedTab?: "entries" | "invoices";
  client: LegalworkServerClient;
  directory: BackOfficeState;
  state: TimesheetState;
  dateLocked?: boolean;
  visible?: boolean;
}) {
  const [date, setDate] = useState(() => initialDate ?? calendarDay(new Date()));
  const [period, setPeriod] = useState<TimePeriod>(initialPeriod ?? "day");
  const [timekeeperTarget, setTimekeeperTarget] = useState<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<string>();
  const [correction, setCorrection] = useState<{ proposal: CaptureProposal; draftRevision?: number }>();
  const [directDecision, setDirectDecision] = useState<DirectProposalDecision>();
  const directInFlight = useRef<DirectProposalDecision>(undefined);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<{ id: string; date: string }>();
  const [confirmDay, setConfirmDay] = useState<string>();
  const [finishedDay, setFinishedDay] = useState<string>();
  const refreshing = run?.date === date;
  const editorId = useId();
  const editor = useRef<HTMLDivElement>(null);
  const editorForm = useRef<HTMLDivElement>(null);
  const focusInsideEditor = useRef(false);
  const editorTitle = useRef<HTMLHeadingElement>(null);
  const timelineBody = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<{ target: "editor" | "timeline"; removed?: HTMLElement }>(undefined);
  const origin = useRef<{ key: string; index: number }>(undefined);
  const modelRequest = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef(false);
  const cache = useQueryClient();
  const dates = periodDates(date, period);
  useEffect(() => { if (initialDate) setDate(initialDate); }, [initialDate]);
  useEffect(() => { if (initialPeriod) setPeriod(initialPeriod); }, [initialPeriod]);
  useEffect(() => {
    setSelection(undefined);
    setCorrection(undefined);
    directInFlight.current = undefined;
    setDirectDecision(undefined);
  }, [date, period]);
  const bindEditor = useCallback((element: HTMLDivElement | null) => {
    if (!element && editor.current && (editor.current.contains(document.activeElement) ||
        (focusInsideEditor.current && document.activeElement === document.body))) {
      focusRequest.current = { target: "timeline", removed: editor.current };
      focusInsideEditor.current = false;
    }
    editor.current = element;
  }, []);
  const bindEditorForm = useCallback((element: HTMLDivElement | null) => {
    if (!element && !focusRequest.current && editorForm.current?.contains(document.activeElement))
      focusRequest.current = { target: "editor", removed: editorForm.current };
    editorForm.current = element;
  }, []);
  function applyFocusRequest() {
    const request = focusRequest.current;
    focusRequest.current = undefined;
    if (!request || request.removed?.isConnected || !visible || timelineBody.current?.closest("[hidden]")) return;
    const panel = timelineBody.current?.closest<HTMLElement>('[data-workspace-tab="timeline"]');
    const buttons = [...(timelineBody.current?.querySelectorAll<HTMLButtonElement>("[data-proposal-id]") ?? [])];
    const from = origin.current;
    const nearby = from && (buttons.find(button => button.dataset.proposalId === from.key) ??
      buttons[from.index] ?? buttons.at(-1));
    const target = request.target === "editor" && editorTitle.current ? editorTitle.current : nearby || panel;
    target?.focus();
  }

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
  const progress = useQuery({
    queryKey: [...scopeKey, "generation", date, run?.id],
    enabled: local && visible && refreshing,
    queryFn: ({ signal }) => run ? client.privateWorkdayProgress({ ...identity, date }, run.id, signal) : null,
    retry: false, refetchInterval: 400, gcTime: 0,
  });
  const generation = refreshing && progress.data?.runId === run?.id ? progress.data : undefined;
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
  const lastStoppedId = lastStopped?.id;
  const refetchWorkday = workday.refetch;
  useEffect(() => {
    if (visible && local && lastStoppedId) void refetchWorkday();
  }, [visible, local, lastStoppedId, refetchWorkday]);

  const data = workday.data;
  const settings = data?.settings;
  const drafts = { ...overview.data, ...data?.drafts };
  const modelSelection = JSON.stringify(settings?.model);
  useEffect(() => {
    return () => { modelRequest.current?.abort(); };
  }, [client, profileId, identity.scope, identity.user, identity.principal, date, modelSelection, visible, settings?.enabled]);
  useEffect(() => {
    setConfirmDay(undefined);
    setFinishedDay(undefined);
  }, [date, visible, settings?.enabled]);

  async function act(action: CaptureAction, signal?: AbortSignal) {
    const foreground = action.type !== "draft";
    const settingsMutation = action.type === "settings" || action.type === "settings-patch";
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
      if (settingsMutation) {
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
      } else if (settingsMutation) {
        await cache.invalidateQueries({ queryKey: [...scopeKey, "day"] });
      }
      return true;
    } catch (e) {
      if (!signal?.aborted) setError(action.type === "suggest" ? t("timeWorkspace.failed")
        : e instanceof Error ? e.message : t("timesheets.unavailable"));
      return false;
    } finally {
      if (foreground) {
        inFlight.current = false;
        setRunning(false);
      }
    }
  }

  async function writeDraft(action: PrivateDraftPatch) {
    const next = await client.privateWorkday({ ...identity, date: action.date }, action);
    const key = dayKey(action.date);
    const updated = next.drafts[action.key];
    await cache.cancelQueries({ queryKey: key, exact: true });
    cache.setQueryData<CaptureState>(key, previous => {
      if (!previous) return next;
      const drafts = { ...previous.drafts };
      if (updated) {
        if ((updated.revision ?? 0) >= (drafts[action.key]?.revision ?? 0)) drafts[action.key] = updated;
      } else if ((drafts[action.key]?.revision ?? 0) <= action.revision) delete drafts[action.key];
      return { ...previous, drafts };
    });
    if (action.date !== date) void cache.invalidateQueries({ queryKey: [...scopeKey, "overview"] });
    return updated ?? null;
  }

  async function addSuggestions() {
    if (modelRequest.current || inFlight.current || !settings || settings.enabled === false) return;
    const controller = new AbortController();
    modelRequest.current = controller;
    const runId = crypto.randomUUID();
    setConfirmDay(undefined);
    setFinishedDay(undefined);
    setRun({ id: runId, date });
    try {
      if (await act({ type: "suggest", runId }, controller.signal)) setFinishedDay(date);
    } finally {
      if (modelRequest.current === controller) {
        modelRequest.current = undefined;
        setRun(undefined);
      }
    }
  }
  const isVisibleProposal = (p: CaptureProposal) =>
    p.date === date && !p.dismissed &&
    !directory.records.some(record => record.objectId === "timeEntries" && record.id === p.key) &&
    !state.entries.some(e => e.workerId === identity.user && (
      e.groupId === p.key || e.proposalDigest === p.digest ||
      (e.proposalDigest && p.versions?.includes(e.proposalDigest))
    ));
  const shown = data?.proposals.filter(isVisibleProposal) ?? [];
  const selectionUnavailable = Boolean(selection && data && !shown.some(item => item.key === selection));
  useEffect(() => {
    if (selectionUnavailable) {
      setSelection(undefined);
      setCorrection(undefined);
    }
  }, [selectionUnavailable]);
  function rememberProposal(key: string, trigger?: HTMLButtonElement) {
    const buttons = [...(timelineBody.current?.querySelectorAll<HTMLButtonElement>("[data-proposal-id]") ?? [])];
    const index = trigger ? buttons.indexOf(trigger) : buttons.findIndex(button => button.dataset.proposalId === key);
    if (index >= 0) origin.current = { key, index };
  }
  function openEditor(proposal: CaptureProposal, trigger?: HTMLButtonElement) {
    rememberProposal(proposal.key, trigger);
    if (selection === proposal.key && correction?.proposal.digest !== proposal.digest) {
      editorTitle.current?.focus();
      return;
    }
    focusRequest.current = { target: "editor" };
    setCorrection(undefined);
    setSelection(proposal.key);
  }
  function decideProposal(proposal: CaptureProposal, action: ProposalDecision, trigger: HTMLButtonElement) {
    const current = directInFlight.current;
    if (current && shown.some(item => item.digest === current.digest && item.key === current.key)) return;
    trigger.focus({ preventScroll: true });
    rememberProposal(proposal.key);
    const request: DirectProposalDecision = {
      key: proposal.key, digest: proposal.digest, action,
      complete: ok => {
        if (directInFlight.current !== request) return;
        directInFlight.current = undefined;
        if (!ok && document.activeElement === trigger) openEditor(proposal);
        setDirectDecision(undefined);
      },
    };
    directInFlight.current = request;
    setDirectDecision(request);
  }
  function closeEditor() {
    focusRequest.current = { target: "timeline" };
    setSelection(undefined);
    setCorrection(undefined);
  }
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
      directInFlight.current = undefined;
      setDirectDecision(undefined);
      setDate(next);
    }
    onDateChange(next, openDay ? "day" : period);
  }
  const capture: TimeCaptureSheet = {
    proposals: shown, visible, wording: data?.wording, privateAvailable: Boolean(data), drafts, date, dates,
    linkableRecords: ownRecords, selectDate, act, writeDraft,
    openSource: (proposal, draftRevision) => {
      focusRequest.current = { target: "editor" };
      setCorrection({ proposal, draftRevision });
    },
  };
  const renderWorkspace: RenderTimeWorkspace = (entries, renderProposal, proposals = shown) => {
    const savedKeys = new Set(proposals.map(proposal => proposal.key));
    const previews = generation?.proposals.filter(proposal => !savedKeys.has(proposal.key) && isVisibleProposal(proposal)) ?? [];
    const selected = proposals.find(proposal => proposal.key === selection);
    const correcting = selected && correction?.proposal.key === selected.key && correction.proposal.digest === selected.digest
      ? correction : undefined;
    const deciding = directDecision && proposals.find(proposal => proposal.key === directDecision.key && proposal.digest === directDecision.digest);
    // Reuse the booking form and keep its validation state if a calendar action opens it.
    const editors = selected ? [selected] : [];
    if (deciding && deciding.key !== selected?.key) editors.push(deciding);
    return <TimeWorkspacePanels visible={visible} scope={JSON.stringify([client.baseUrl, directory.directoryId, identity])}
      entries={entries} invoices={invoices} requestedTab={requestedTab}
      chat={shown => <TimeWorkspaceChat client={client} identity={identity} date={date} visible={shown && visible} data={data} />}
      timeline={(view, choose) => (
        <>
          <div className="time-workspace-private-toolbar shrink-0">
            {local && settings && settings.enabled !== false && <>
              <Button size="sm" variant="outline" disabled={running || refreshing || date > calendarDay(new Date())}
                onClick={() => setConfirmDay(date)}>{refreshing ? <Loader2 className="animate-spin" /> : <Plus />}
                {t("timeWorkspace.addSuggestions")}</Button>
            </>}
            {local && <TimeSelect modal={false} label={t("timeWorkspace.timelineView")} value={view} options={[
              { id: "combined", name: t("timeWorkspace.combined") }, { id: "matters", name: t("timeWorkspace.byMatter") },
            ]} onChange={value => {
              if (value === "combined" || value === "matters") choose(value);
            }} />}
          </div>
          {local && settings && settings.enabled !== false && <WorkdaySuggestionFeedback date={date}
            confirm={confirmDay === date} running={refreshing} progress={generation}
            finished={finishedDay === date && data?.status?.type === "ready" ? shown.length : undefined}
            onStart={() => void addSuggestions()} onCancel={() => { setConfirmDay(undefined); modelRequest.current?.abort(); }} />}
          {settings?.enabled !== false && !refreshing && status && <SuggestionFailure status={status} />}
          {!local && <p className="time-workspace-note">{t("timesheets.local_only")}</p>}
          {local && (
            <div ref={timelineBody} className="relative isolate min-h-0 flex-1 overflow-hidden">
              <WorkdayTimeline date={date} proposals={proposals} previews={previews} drafts={drafts} state={state} view={view} selected={selected?.key}
                renderTimeOverlay={settings && settings.enabled !== false ? now =>
                  <WorkdayCoverage date={date} checkedThrough={data?.checkedThrough} now={now}
                    busy={running || refreshing} onCheck={() => setConfirmDay(date)} /> : undefined}
                editorId={editorId} onOpen={openEditor} decisions={{
                  canAccept: directory.permissions.edit,
                  busyKey: deciding?.key ?? correcting?.proposal.key,
                  onDecision: decideProposal,
                  onFocusedRemoval: (proposal, element) => {
                    rememberProposal(proposal.key);
                    focusRequest.current ??= { target: "timeline", removed: element };
                  },
                }} />
              <DirectProposalDecisionContext.Provider value={directDecision}>
                {editors.map(proposal => {
                  const active = proposal.key === selected?.key;
                  const edit = active ? correcting : undefined;
                  const title = workdayProposalDisplay(proposal, state, drafts[proposal.key]).title;
                  const source = t(sourceKeys[proposal.source]);
                  return <Dialog key={proposal.key} open={active} modal={false} onOpenChange={(open, details) => {
                    if (open || !active || details.reason === "focus-out") return;
                    // Escape in a picker belongs to that picker, and interactions in the other pane stay independent.
                    if ((details.reason === "escape-key" || details.reason === "outside-press") &&
                        (details.event.defaultPrevented || !(details.event.target instanceof Node) ||
                         !timelineBody.current?.contains(details.event.target))) return;
                    closeEditor();
                  }}>
                    <ItemDialogContent container={timelineBody} keepMounted portalClassName={active ? undefined : "hidden"}
                      ref={active ? bindEditor : undefined} id={active ? editorId : undefined}
                      className="time-workspace-editor max-h-[calc(100%-1rem)] w-[calc(100%-1rem)] sm:max-w-lg"
                      onFocusCapture={() => { focusInsideEditor.current = true; }}
                      onBlurCapture={event => {
                        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focusInsideEditor.current = false;
                      }}
                      initialFocus={active ? editorTitle : false} finalFocus={false}>
                      <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pe-14">
                        <DialogTitle render={<h3 />} ref={active ? editorTitle : undefined} tabIndex={-1}>
                          <ItemDetailLabel icon={<CalendarClock />}>{title}</ItemDetailLabel>
                        </DialogTitle>
                        <DialogDescription className={source === title && !proposal.observation ? "sr-only" : "text-xs"}>
                          {source}
                          {proposal.observation === "foreground" && " · " + t("timeWorkspace.foreground")}
                          {proposal.observation === "passive" && " · " + t("timeWorkspace.passive")}
                        </DialogDescription>
                      </DialogHeader>
                      <div key={proposal.digest} ref={active ? bindEditorForm : undefined} className="min-h-0 overflow-y-auto px-5 py-4">
                        <div hidden={Boolean(edit)}>{renderProposal(proposal)}</div>
                        {edit && <WorkdayCorrectionForm proposal={edit.proposal} draftRevision={edit.draftRevision} state={state}
                          pending={running} save={act} close={() => {
                            if (editor.current?.contains(document.activeElement)) focusRequest.current = { target: "editor" };
                            setCorrection(undefined);
                          }} />}
                      </div>
                    </ItemDialogContent>
                  </Dialog>;
                })}
              </DirectProposalDecisionContext.Provider>
            </div>
          )}
          <CommitProposalFocus apply={applyFocusRequest} />
        </>
      )}
    />;
  };
  const status = data?.status;
  return (
    <section className="bo-workday time-unified">
      {visible && <TimeHeaderContent slot={WorkspaceHeaderTarget}><div className="bo-workday-controls titlebar-no-drag" role="toolbar" aria-label={t("timesheets.workspace_title")}>
        <div className="time-sheet-period">
          <Button size="icon-sm" variant="ghost" aria-label={t(period === "month" ? "calendar.previous" : period === "week" ? "calendar.previous_week" : "calendar.previous_day")}
            onClick={() => selectDate(adjacentPeriod(date, period, -1))}><ChevronLeft size={16} /></Button>
          <label>
            <Input className="h-7 w-[8.5rem] text-xs"
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
        <TimesheetPeriodSwitch period={period} onChange={next => { setPeriod(next); onDateChange(date, next); }} />
        <div ref={setTimekeeperTarget} className="time-workspace-timekeeper" />
        {local && profileId && <TimeWorkspaceStopwatch key={profileId} stopwatch={stopwatch} matters={state.matters} />}
      </div></TimeHeaderContent>}
      {(error || workday.error || overview.error) && <p className="time-workspace-status" role="alert">
        {error || workday.error?.message || overview.error?.message}
        {workday.error && <Button variant="ghost" size="xs" onClick={() => void workday.refetch()}>{t("timesheets.retry")}</Button>}
        {overview.error && <Button variant="ghost" size="xs" onClick={() => void overview.refetch()}>{t("timesheets.retry")}</Button>}
      </p>}
      <TimekeeperControlTarget.Provider value={timekeeperTarget}>{children(capture, renderWorkspace)}</TimekeeperControlTarget.Provider>
    </section>
  );
}
