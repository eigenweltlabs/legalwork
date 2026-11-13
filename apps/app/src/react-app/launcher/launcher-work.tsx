import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Loader2, OctagonX, Reply, Shuffle } from "lucide-react";
import type { AssistantWorkItem, AssistantWorkStatus } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/app/utils";
import { t } from "@/i18n";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { useLauncherShell } from "./launcher-shell";
import { useLauncherStore } from "./launcher-store";
import { handleLauncherFocusKey } from "./launcher-focus";
import { LauncherForm, LauncherSubmitHint } from "./launcher-form";

const STATUSES: AssistantWorkStatus[] = ["input-required", "running", "queued", "returned", "stopped", "failed", "unavailable"];

/** Work spans conversations and days; every control names exactly one job. */
export function LauncherWork(props: { onOpenConversation: (conversationId: string) => void }) {
  const { client, openInApp, workspaces } = useLauncherShell();
  const notify = useLauncherStore(state => state.notify);
  const [status, setStatus] = useState<AssistantWorkStatus | "all">("all");
  const [projectId, setProjectId] = useState<string>("");
  const [editing, setEditing] = useState<{ id: string; action: "reply" | "redirect"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const running = useRef(false);
  const editorTrigger = useRef<{ id: string; action: "reply" | "redirect" } | null>(null);
  useLayoutEffect(() => { root.current?.focus(); }, []);
  useLayoutEffect(() => { if (busy && !editing) root.current?.focus(); }, [busy, editing]);
  const closeEditor = () => {
    setEditing(null);
    requestAnimationFrame(() => {
      const article = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-work-id]") ?? []).find(item => item.dataset.workId === editorTrigger.current?.id);
      (article?.querySelector<HTMLElement>(`[data-work-action="${editorTrigger.current?.action}"]`) ?? root.current)?.focus();
    });
  };
  const work = useQuery({ queryKey: ["launcher-work", client.baseUrl, status, projectId], queryFn: () => client.assistantWork({ ...(status !== "all" ? { status } : {}), ...(projectId ? { projectId } : {}) }), refetchInterval: 5000, refetchOnWindowFocus: true });
  useEffect(() => onSyncPoke(poke => { if (poke.sessions || poke.approvals || poke.resync) void work.refetch(); }), [work]);
  const act = async (item: AssistantWorkItem, action: "stop" | "redirect" | "reply", prompt?: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(item.id);
    try {
      await client.assistantWorkAction(item, action, { prompt, requestId: `work_${crypto.randomUUID()}` });
      notify({ tone: "info", text: t(`launcher.work.done_${action}`, { title: item.title }) });
      if (editing?.id === item.id) closeEditor();
    } catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally { running.current = false; setBusy(null); void work.refetch(); }
  };
  return <div ref={root} tabIndex={-1} data-launcher-controls onFocusCapture={event => { if (event.target !== root.current) event.target.scrollIntoView({ block: "nearest" }); }} onKeyDown={event => { if (!event.defaultPrevented) handleLauncherFocusKey(event, root.current, true); }}>
    <div className="launcher-section-title">
      <span>{t("launcher.work.title")}</span>
      <span className="launcher-coverage flex gap-2">
        <select aria-label={t("launcher.work.filter_status")} value={status} onChange={event => setStatus(STATUSES.find(value => value === event.target.value) ?? "all")} className="rounded-md border border-border bg-transparent px-1 text-xs">
          <option value="all">{t("launcher.work.status_all")}</option>{STATUSES.map(value => <option key={value} value={value}>{t(`launcher.work.status.${value}`)}</option>)}
        </select>
        <select aria-label={t("launcher.work.filter_project")} value={projectId} onChange={event => setProjectId(event.target.value)} className="max-w-32 rounded-md border border-border bg-transparent px-1 text-xs">
          <option value="">{t("content_search.all_projects")}</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.displayName || workspace.name}</option>)}
        </select>
      </span>
    </div>
    {work.isPending && <div className="launcher-status"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />{t("launcher.work.loading")}</div>}
    {work.isError && <p role="alert" className="launcher-notice" data-tone="error">{t("launcher.work.unavailable")}</p>}
    {work.data && !work.data.items.length && <p className="launcher-empty">{t("launcher.work.empty")}</p>}
    {work.data?.items.map(item => <article key={item.id} className="launcher-work-item" data-work-id={item.id} data-status={item.status}>
      <div className="flex items-center justify-between gap-2"><span className="launcher-work-status" data-status={item.status}>{t(`launcher.work.status.${item.status}`)}{item.pendingAttention ? ` · ${t("launcher.work.pending", { count: item.pendingAttention })}` : ""}</span><span className="launcher-row-meta">{item.projectName}{item.updatedAt ? ` · ${formatRelativeTime(item.updatedAt)}` : ""}</span></div>
      <div className="launcher-row-title">{item.title}</div>
      {item.result?.preview && <div className="launcher-row-excerpt">{item.result.preview}</div>}
      {editing?.id === item.id ? <LauncherForm title={t(`launcher.work.${editing.action}`)} busy={busy === item.id} onClose={closeEditor} onSubmit={() => { if (editing.text.trim()) void act(item, editing.action, editing.text.trim()); }}>
        <textarea autoFocus rows={3} disabled={busy === item.id} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} placeholder={t(editing.action === "reply" ? "launcher.work.reply_placeholder" : "launcher.work.redirect_placeholder")} aria-label={t(`launcher.work.${editing.action}`)} />
        <div className="launcher-form-actions"><Button type="button" size="sm" variant="ghost" disabled={busy === item.id} onClick={closeEditor}>{t("common.cancel")}<kbd>Esc</kbd></Button><Button type="submit" size="sm" disabled={busy === item.id || !editing.text.trim()}>{t(`launcher.work.${editing.action}`)}<LauncherSubmitHint /></Button></div>
      </LauncherForm> : <div className="launcher-work-actions">
        <Button size="sm" variant="ghost" onClick={() => openInApp(workspaceSessionRoute(item.workspaceId, item.sessionId))}><ArrowUpRight className="size-3.5" />{t("launcher.work.open")}</Button>
        {item.originConversationId && <Button size="sm" variant="ghost" onClick={() => { if (item.originConversationId) props.onOpenConversation(item.originConversationId); }}>{t("launcher.work.origin")}</Button>}
        {(item.status === "running" || item.status === "queued" || item.status === "input-required") && <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => void act(item, "stop")}><OctagonX className="size-3.5" />{t("launcher.work.stop")}</Button>}
        {item.status !== "unavailable" && <Button data-work-action="reply" size="sm" variant="ghost" onClick={() => { editorTrigger.current = { id: item.id, action: "reply" }; setEditing({ id: item.id, action: "reply", text: "" }); }}><Reply className="size-3.5" />{t("launcher.work.reply")}</Button>}
        {(item.status === "running" || item.status === "queued") && <Button data-work-action="redirect" size="sm" variant="ghost" onClick={() => { editorTrigger.current = { id: item.id, action: "redirect" }; setEditing({ id: item.id, action: "redirect", text: "" }); }}><Shuffle className="size-3.5" />{t("launcher.work.redirect")}</Button>}
      </div>}
    </article>)}
  </div>;
}
