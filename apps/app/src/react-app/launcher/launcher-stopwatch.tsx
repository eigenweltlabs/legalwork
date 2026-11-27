import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StopwatchAction } from "@legalwork/types/time-capture";
import { isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { calendarClientScope } from "@/react-app/domains/calendar/calendar-cache";
import { timeTrackingProfile } from "@/react-app/domains/back-office/time-tracking-profile";
import { TimeRecordPicker } from "@/react-app/domains/back-office/time-settings-controls";
import { stopwatchElapsed, useTimeWorkspaceStopwatch } from "@/react-app/domains/back-office/time-workspace-stopwatch";
import { LauncherForm, LauncherSubmitHint, type LauncherFormState } from "./launcher-form";

/** The mini-bar observes the same account-scoped timer as Time and the desktop HUD. */
export function useLauncherStopwatch(client: LegalworkServerClient, visible: boolean) {
  const supported = isLoopbackLegalworkServerUrl(client.baseUrl);
  const profile = useQuery({ ...timeTrackingProfile(client), enabled: visible && supported });
  const profileId = profile.isError ? undefined : profile.data?.profileId;
  const stopwatch = useTimeWorkspaceStopwatch(client, profileId, visible && supported);
  const available = Boolean(profileId && stopwatch.data) && !stopwatch.isError;
  const retry = async () => {
    const result = await profile.refetch();
    if (!result.isError && result.data?.profileId === profileId) await stopwatch.refetch();
  };
  return { supported, profileId, stopwatch, available, retry, loading: profile.isPending || (!profile.isError && stopwatch.isPending) };
}

export function LauncherStopwatchClock({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  const time = stopwatchElapsed(startedAt, now);
  return <span className="tabular-nums" role="timer" aria-label={t("timeWorkspace.stopwatchElapsed", { time })}>{time}</span>;
}

export function LauncherStopwatch({ client, timer, onClose, onOpenApp, onFormStateChange }: {
  client: LegalworkServerClient;
  timer: ReturnType<typeof useLauncherStopwatch>;
  onClose: () => void;
  onOpenApp: () => void | Promise<void>;
  onFormStateChange: (state: LauncherFormState) => void;
}) {
  const { stopwatch, profileId, available, loading } = timer;
  const active = available ? stopwatch.data?.active : undefined;
  const [matter, setMatter] = useState("");
  const [noteEdit, setNoteEdit] = useState<{ run: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [saved, setSaved] = useState(false);
  const working = useRef(false);
  const startRetry = useRef<Extract<StopwatchAction, { type: "start" }>>(undefined);
  const submit = useRef<HTMLButtonElement>(null);
  const openAppButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const run = active?.id ?? "idle";
  const note = noteEdit?.run === run ? noteEdit.text : active?.note ?? "";
  const disabled = available && stopwatch.data?.enabled === false && !active;
  // Only the editor fetches the matter directory; clock polling stays lightweight.
  const matters = useQuery({
    queryKey: ["launcher-stopwatch-matters", ...calendarClientScope(client), profileId],
    enabled: available && !disabled,
    retry: false,
    queryFn: async () => {
      if (!profileId) throw new Error(t("timeWorkspace.stopwatchUnavailable"));
      const state = await client.privateStopwatch(undefined, profileId, true);
      if (state.profileId !== profileId) throw new Error(t("timesheets.account_changed"));
      return state.matters ?? [];
    },
  });
  useEffect(() => {
    if (loading || focused.current) return;
    focused.current = true;
    (submit.current ?? openAppButton.current)?.focus();
  }, [loading]);
  const perform = async (action: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true); setFailure("");
    try { await action(); }
    catch (error) { setFailure(error instanceof Error ? error.message : t("timeWorkspace.stopwatchFailed")); }
    finally { working.current = false; setBusy(false); }
  };
  const change = async (action: StopwatchAction) => {
    await stopwatch.change(action);
    if (action.type === "stop") { setSaved(true); setNoteEdit(null); setMatter(""); }
    if (action.type === "start") { setSaved(false); startRetry.current = undefined; }
  };
  const confirm = () => {
    if (loading || disabled) return;
    void perform(async () => {
      if (!available) { await timer.retry(); return; }
      if (active) { await change({ type: "stop", id: active.id, ...(note !== (active.note ?? "") ? { note } : {}) }); return; }
      const matterId = matter || null;
      if (matterId && !matters.data?.some(item => item.id === matterId)) throw new Error(t("launcher.stopwatch.matter_unavailable"));
      if (!startRetry.current || startRetry.current.matterId !== matterId || (startRetry.current.note ?? "") !== note) {
        startRetry.current = { type: "start", id: crypto.randomUUID(), matterId, ...(note ? { note } : {}) };
      }
      await change(startRetry.current);
    });
  };
  return <LauncherForm title={t("timesheets.source.stopwatch")} busy={busy} onClose={onClose} onSubmit={confirm} onStateChange={onFormStateChange}>
    {active && <div className="text-3xl"><LauncherStopwatchClock startedAt={active.startedAt} /></div>}
    <p className="text-sm text-muted-foreground">{t("launcher.stopwatch.help")}</p>
    {loading ? <p role="status">{t("timesheets.loading")}</p> : !available ? <p role="alert">{t("timeWorkspace.stopwatchUnavailable")}</p> : disabled ? <p role="status">{t("timeWorkspace.trackingOff")}</p> :
      <fieldset disabled={busy} className="grid min-w-0 gap-3">
        <div className="grid gap-1.5 text-sm">
          <span>{t("timeWorkspace.optionalMatter")}</span>
          <TimeRecordPicker label={t("timeWorkspace.optionalMatter")} placeholder={t("timesheets.workday.choose")}
            value={active ? active.matterId ?? "" : matter}
            disabled={!matters.data || matters.isError || (stopwatch.data?.enabled === false && Boolean(active?.matterId))}
            options={[{ id: "", name: t("timesheets.workday.unassigned") }, ...(matters.data ?? [])]}
            onChange={id => {
              if (active && active.matterId !== (id || null)) void perform(() => change({ type: "assign", id: active.id, matterId: id || null }));
              else setMatter(id);
            }} />
          {matters.isError && <div role="status">{t("launcher.stopwatch.matters_failed")} <Button type="button" variant="link" size="sm" onClick={() => void matters.refetch()}>{t("timesheets.retry")}</Button></div>}
        </div>
        <label className="grid gap-1.5 text-sm">{t("timeWorkspace.quickNote")}
          <Input value={note} maxLength={2000} onChange={event => setNoteEdit({ run, text: event.target.value })} />
        </label>
      </fieldset>}
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    {saved && <p role="status" className="text-sm">{t("timeWorkspace.stopwatchSaved")}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button ref={openAppButton} autoFocus type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void perform(async () => { await onOpenApp(); })}>{t("launcher.stopwatch.open_time")}</Button>
      {!disabled && <Button ref={submit} type="submit" size="sm" disabled={busy || loading}>
        {t(!available && !loading ? "timesheets.retry" : active ? "timeWorkspace.stopwatchStop" : "timeWorkspace.stopwatchStart")} <LauncherSubmitHint />
      </Button>}
    </div>
  </LauncherForm>;
}
