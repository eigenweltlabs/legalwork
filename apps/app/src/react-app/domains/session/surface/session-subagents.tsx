import { useEffect, useMemo, useState } from "react";
import type { Client } from "@/app/types";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { LoaderCircle, X } from "lucide-react";
import { SubagentDot, subagentColors } from "@/components/chat/subagent-dot";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useQueryCacheState } from "../../../infra/query-cache-state";
import { emptyInteractionSessions, interactionSessionIds, interactionSessionsKey, type InteractionSessions } from "../sync/interaction-state";
import { getSessionActivityStatusLabel, useSessionActivityStore, type SessionActivityStatus } from "../status/session-activity-store";
import { stopSubagentRun } from "./stop-subagent";

const emptyStatuses: Record<string, SessionActivityStatus> = {};
type SubagentActivity = { id: string; title: string; status: SessionActivityStatus };
export const isRunningSubagent = (status: SessionActivityStatus) => status === "thinking" || status === "responding" || status === "compacting";

export function sessionSubagents(sessionId: string, sessions: InteractionSessions, statuses: Record<string, SessionActivityStatus>, waiting: readonly string[] = []) {
  return interactionSessionIds(sessionId, sessions).filter(id => id !== sessionId && sessions[id]).map<SubagentActivity>(id => ({
    id, title: sessions[id].title, status: waiting.includes(id) ? "waiting" : statuses[id] ?? "idle",
  })).sort((a, b) => Number(isRunningSubagent(b.status)) - Number(isRunningSubagent(a.status)));
}

/** Stays open while working in the chat. It is not a modal or a navigation change. */
export function SessionSubagents({ workspaceId, workspaceRoot, sessionId, client, serverClient, waiting, onOpen }: {
  workspaceId: string; workspaceRoot: string; sessionId: string; client: Client | null; serverClient: LegalworkServerClient; waiting?: string[]; onOpen?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<string[]>([]);
  const [stopped, setStopped] = useState<string[]>([]);
  const key = useMemo(() => interactionSessionsKey(workspaceId), [workspaceId]);
  const sessions = useQueryCacheState<InteractionSessions>(key, emptyInteractionSessions);
  const statuses = useSessionActivityStore(state => state.statusesByWorkspaceId[workspaceId] ?? emptyStatuses);
  const agents = sessionSubagents(sessionId, sessions, statuses, waiting?.filter(id => !stopped.includes(id)));
  const ids = agents.map(agent => agent.id).sort().join("|");
  const colors = useMemo(() => subagentColors(sessionId, sessions), [sessionId, sessions]);
  // The visible surface already reads this complete workspace status map.
  const runs = useQueryCacheState<{ started: number; statuses: Record<string, import("@opencode/client").SessionStatus> } | null>(
    ["subagent-run-status", serverClient.baseUrl, workspaceId], null,
  );
  useEffect(() => {
    if (!runs) return;
    const store = useSessionActivityStore.getState();
    for (const id of ids.split("|").filter(Boolean)) {
      if ((store.recordsByWorkspaceId[workspaceId]?.[id]?.updatedAt ?? 0) > runs.started) continue;
      store.setRunStatus(workspaceId, id, runs.statuses[id] ?? { type: "idle" });
    }
  }, [runs, ids, workspaceId]);
  useEffect(() => {
    setStopped(previous => previous.some(id => statuses[id] && statuses[id] !== "idle")
      ? previous.filter(id => !statuses[id] || statuses[id] === "idle") : previous);
  }, [statuses]);
  const stop = async (id: string) => {
    if (!client || stopping.includes(id)) return;
    setStopping(previous => [...previous, id]);
    try {
      await stopSubagentRun({ client, serverClient, workspaceId, workspaceRoot, sessionId: id });
      setStopped(previous => [...previous.filter(value => value !== id), id]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("session.stop_failed"));
    } finally {
      setStopping(previous => previous.filter(value => value !== id));
    }
  };
  if (!agents.length) return null;
  const count = agents.filter(agent => isRunningSubagent(agent.status)).length;
  return <div className="pointer-events-none absolute inset-x-3 top-2 z-40 flex flex-col items-end">
    <Button variant="ghost" size="sm" className="pointer-events-auto mr-9 h-8 min-w-7 gap-1.5 rounded-full bg-dls-surface/90 px-2 text-muted-foreground" onClick={() => setOpen(value => !value)}
      aria-expanded={open} aria-label={t("session.subagents_running", { count })} title={t("session.subagents_running", { count })}>
      <span aria-hidden className="flex items-center gap-1.5 px-0.5">{agents.slice(0, 3).map(agent => <SubagentDot key={agent.id} color={colors.get(agent.id)} status={agent.status} compact />)}</span>
      {count > 0 ? <span className="text-[11px] leading-none tabular-nums">{count}</span> : null}
    </Button>
    {open && <section aria-label={t("session.subagents")} className="pointer-events-auto mt-1 w-72 max-w-full rounded-lg border bg-popover text-popover-foreground shadow-md">
      <div className="flex h-8 items-center justify-between px-2.5"><span className="text-xs font-medium">{t(count > 0 ? "session.subagents_running" : "session.subagents", { count })}</span>
        <Button variant="ghost" size="icon-xs" className="-mr-1" onClick={() => setOpen(false)} aria-label={t("session.subagents_close")}><X className="size-3" /></Button></div>
      <div className="max-h-60 overflow-y-auto px-1 pb-1">{agents.map(agent => {
        const wasStopped = stopped.includes(agent.id) && agent.status === "idle";
        const isStopping = stopping.includes(agent.id);
        const label = wasStopped ? t("session.subagent_stopped") : agent.status === "idle" ? t("session.subagent_completed") : getSessionActivityStatusLabel(agent.status);
        return <div key={agent.id} className="flex items-center gap-0.5">
          <Button variant="ghost" disabled={!onOpen} title={`${agent.title} · ${label}`} aria-label={`${agent.title} · ${label}`} onClick={() => onOpen?.(agent.id)} className="h-7 min-w-0 flex-1 justify-start gap-2 rounded-md px-2 py-0 text-left text-xs font-normal disabled:opacity-100">
            <SubagentDot color={colors.get(agent.id)} status={agent.status} stopped={wasStopped} />
            <span className="min-w-0 truncate">{agent.title}</span>
          </Button>
          {(isRunningSubagent(agent.status) || agent.status === "waiting" || isStopping) && <Button variant="ghost" size="icon-xs" className="mr-1 size-5 shrink-0 rounded-full bg-foreground/5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" disabled={!client || isStopping} aria-label={t("session.subagent_stop", { name: agent.title })} title={t("session.subagent_stop", { name: agent.title })} onClick={() => void stop(agent.id)}>
            {isStopping ? <LoaderCircle aria-hidden className="size-2.5 motion-safe:animate-spin" /> : <X aria-hidden className="size-2.5" />}
          </Button>}
        </div>;
      })}</div>
    </section>}
  </div>;
}
