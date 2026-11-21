import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Timer } from "lucide-react";
import type { StopwatchAction, StopwatchState } from "@legalwork/types/time-capture";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { calendarClientScope } from "../calendar/calendar-cache";

function applied(state: StopwatchState, action: StopwatchAction) {
  if (action.type === "stop") return state.lastStopped?.id === action.id;
  if (action.type === "start") return state.active?.id === action.id || state.lastStopped?.id === action.id;
  return state.active?.id === action.id && state.active.projectId === (action.projectId ?? null);
}

export function useTimeWorkspaceStopwatch(client: LegalworkServerClient, profileId: string | undefined, enabled: boolean) {
  const cache = useQueryClient();
  const key = ["private-stopwatch", ...calendarClientScope(client), profileId];
  async function request(action?: StopwatchAction) {
    if (!profileId) throw new Error(t("timeWorkspace.stopwatchUnavailable"));
    const state = await client.privateStopwatch(action, profileId);
    if (state.profileId !== profileId) throw new Error(t("timesheets.account_changed"));
    return state;
  }
  const query = useQuery({
    queryKey: key,
    queryFn: () => request(),
    enabled: enabled && Boolean(profileId),
    retry: false,
    refetchInterval: 5000,
  });
  async function publish(state: StopwatchState) {
    await cache.cancelQueries({ queryKey: key, exact: true });
    cache.setQueryData(key, state);
    return state;
  }
  async function change(action: StopwatchAction) {
    await cache.cancelQueries({ queryKey: key, exact: true });
    try {
      return await publish(await request(action));
    } catch (error) {
      // A timeout may happen after the device saved the action. Read the same
      // profile before retrying so both the HUD and the workspace see one run.
      const current = await request().catch(() => undefined);
      if (current) {
        await publish(current);
        if (applied(current, action)) return current;
      }
      throw error;
    }
  }
  return { ...query, change };
}

function elapsed(startedAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const values = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return values.slice(values[0] > 0 ? 0 : 1).map(value => String(value).padStart(2, "0")).join(":");
}

export function TimeWorkspaceStopwatch({ stopwatch }: { stopwatch: ReturnType<typeof useTimeWorkspaceStopwatch> }) {
  const clockId = useId();
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  const working = useRef(false);
  const restoreFocus = useRef<"project" | "action">(undefined);
  const startRetry = useRef<StopwatchAction>(undefined);
  const available = Boolean(stopwatch.data) && !stopwatch.isError;
  const active = available ? stopwatch.data?.active : undefined;
  const clock = active ? elapsed(active.startedAt, now) : null;
  useEffect(() => {
    if (!active?.startedAt) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active?.startedAt]);
  useLayoutEffect(() => {
    if (pending || !open || !restoreFocus.current) return;
    const element = restoreFocus.current === "project" ? picker.current : actionButton.current;
    restoreFocus.current = undefined;
    element?.focus();
  }, [open, pending]);

  async function change(action: StopwatchAction) {
    if (working.current) return;
    working.current = true;
    setPending(true);
    setFailure(false);
    try {
      const current = await stopwatch.change(action);
      if (action.type === "assign") {
        restoreFocus.current = "project";
        return;
      }
      startRetry.current = undefined;
      setNotice(action.type === "stop" ? t("timeWorkspace.stopwatchSaved")
        : current.active?.id === action.id ? t("timeWorkspace.stopwatchRunning") : "");
      setOpen(false);
    } catch {
      setFailure(true);
      restoreFocus.current = action.type === "assign" ? "project" : "action";
    } finally {
      working.current = false;
      setPending(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={next => {
      setOpen(next);
      if (next) {
        restoreFocus.current = undefined;
        setProject("");
        setNotice("");
        setFailure(false);
        void stopwatch.refetch();
      }
    }}>
      <PopoverTrigger render={<Button type="button" size="sm" variant="outline" ref={trigger}
        aria-label={t("timesheets.source.stopwatch")} aria-describedby={clock ? clockId : undefined} />}>
        <Timer size={15} />{t("timesheets.source.stopwatch")}
        {clock && <span className="tabular-nums" aria-hidden="true">{clock}</span>}
      </PopoverTrigger>
      {clock && <span id={clockId} className="sr-only">{t("timeWorkspace.stopwatchElapsed", { time: clock })}</span>}
      <span role="status" className="sr-only">{notice}</span>
      <PopoverContent align="end" className="w-[min(22rem,92vw)]"
        initialFocus={() => picker.current ?? actionButton.current} finalFocus={trigger}>
        <PopoverTitle>{t("timesheets.source.stopwatch")}</PopoverTitle>
        {stopwatch.isPending && <p role="status">{t("timesheets.loading")}</p>}
        {!stopwatch.isPending && !available && <p role="status">{t("timeWorkspace.stopwatchUnavailable")}</p>}
        <form className="time-workspace-form" aria-busy={pending} onSubmit={event => {
          event.preventDefault();
          if (working.current || stopwatch.isPending) return;
          if (!available) { void stopwatch.refetch(); return; }
          if (active) { void change({ type: "stop", id: active.id }); return; }
          const projectId = project || undefined;
          if (!startRetry.current || startRetry.current.projectId !== projectId) {
            startRetry.current = { type: "start", id: crypto.randomUUID(), ...(projectId && { projectId }) };
          }
          void change(startRetry.current);
        }}>
          {available && <label>{t("timeWorkspace.stopwatchProject")}
            <select ref={picker} value={active ? active.projectId ?? "" : project} disabled={pending}
              onChange={event => {
                const chosen = event.currentTarget.value;
                if (!active) { setProject(chosen); return; }
                if (chosen !== (active.projectId ?? "")) void change({
                  type: "assign", id: active.id, ...(chosen && { projectId: chosen }),
                });
              }}>
              <option value="">{t("projects.no_project")}</option>
              {stopwatch.data?.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>}
          {failure && <p role="alert">{t("timeWorkspace.stopwatchFailed")}</p>}
          <Button ref={actionButton} type="submit" size="sm" disabled={pending || stopwatch.isPending}>
            {t(!available ? "timesheets.retry" : active ? "timeWorkspace.stopwatchStop" : "timeWorkspace.stopwatchStart")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
