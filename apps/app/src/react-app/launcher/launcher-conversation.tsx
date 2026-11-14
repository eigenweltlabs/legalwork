import { submissionKeys } from "./launcher-labels";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, ArrowUpRight, ClipboardPaste, Copy, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import type { AssistantAttentionItem, AssistantAttentionReply } from "@legalwork/types/main-assistant";
import { AssistantSubmissionStateSchema, type AssistantSubmission } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { launcherOriginInsert } from "@/app/lib/desktop";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { OpenTargetProvider } from "@/lib/target-provider";
import { t } from "@/i18n";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { QuestionPanel } from "@/react-app/domains/session/modals/question-modal";
import { permissionDetailRows } from "@/react-app/domains/session/chat/permission-approval-modal";
import { snapshotToUIMessages } from "@/react-app/domains/session/sync/usechat-adapter";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { useLauncherShell } from "./launcher-shell";
import { useLauncherStore, type LauncherConversationBinding } from "./launcher-store";
import { nextSubmissionPollMs } from "./submission-identity";
import { copyLauncherText } from "./launcher-clipboard";

/** Keep polling one identified request until the engine answered; retries never create a second message. */
export function useSubmissionStatus(requestId: string | null, onChange: (submission: AssistantSubmission) => void) {
  const { client } = useLauncherShell();
  useEffect(() => {
    if (!requestId) return;
    let cancelled = false, attempt = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { submission } = await client.assistantSubmission(requestId);
        if (cancelled) return;
        onChange(submission);
        const next = nextSubmissionPollMs(submission.state, attempt++);
        if (next !== null) timer = setTimeout(poll, next);
      } catch { if (!cancelled) timer = setTimeout(poll, 3000); }
    };
    timer = setTimeout(poll, 800);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, requestId, onChange]);
}

export function SubmissionStatusRow({ submission, onRetry }: { submission: { requestId: string; state: string; error?: string | null } | null; onRetry: () => void }) {
  if (!submission || submission.state === "completed") return null;
  const state = AssistantSubmissionStateSchema.safeParse(submission.state);
  const busy = submission.state === "sending" || submission.state === "accepted" || submission.state === "running";
  return <div className="launcher-status" role="status" aria-live="polite">
    {busy ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <AlertTriangle className="size-3.5" />}
    <span>{submission.state === "failed" && submission.error ? submission.error : t(state.success ? submissionKeys[state.data] : "launcher.submission.unconfirmed")}</span>
    {(submission.state === "unconfirmed" || submission.state === "failed") && <Button variant="ghost" size="sm" onClick={onRetry}><RefreshCw className="size-3.5" />{t("launcher.submission.retry")}</Button>}
  </div>;
}

/** Pending questions and approvals are system UI: read from the server, never only from what the model presents. */
export function AttentionCards({ items, busy, onReply, onOpen }: { items: AssistantAttentionItem[]; busy: string | null; onReply: (item: AssistantAttentionItem, answer: { kind: "approval"; reply: "once" | "reject" } | { kind: "question"; answers: string[][] }) => void; onOpen: (item: AssistantAttentionItem) => void }) {
  if (!items.length) return null;
  return <>{items.map(item => <article key={`${item.id}:${item.revision}`} className="launcher-attention" data-attention-kind={item.kind}>
    <div className="launcher-attention-head"><strong>{item.presentation?.title ?? (item.kind === "approval" ? t("assistant.attention_approval") : t("launcher.attention.question"))}</strong>{item.projectName} · {item.sessionTitle}{item.presentation?.description ? ` · ${item.presentation.description}` : ""}
      <Button size="icon-sm" variant="ghost" className="float-right" aria-label={t("assistant.open_chat")} onClick={() => onOpen(item)}><ArrowUpRight className="size-4" /></Button></div>
    {item.kind === "approval" ? <div className="space-y-2 p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />{item.permission}</p>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-2 py-1 text-xs">{item.patterns.join("\n")}</pre>
      {permissionDetailRows(item.metadata).slice(0, 2).map(row => <div key={row.label}><p className="text-xs text-muted-foreground">{row.label}</p><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs">{row.value}</pre></div>)}
      <div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => onReply(item, { kind: "approval", reply: "reject" })}>{t("session.deny")}</Button><Button size="sm" disabled={busy !== null} onClick={() => onReply(item, { kind: "approval", reply: "once" })}>{busy === item.id && <Loader2 className="size-3 animate-spin" />}{t("session.allow_once")}</Button></div>
    </div> : item.kind === "question" ? <QuestionPanel questions={item.questions} busy={busy !== null} onReply={answers => onReply(item, { kind: "question", answers })} /> : null}
  </article>)}</>;
}

export type PendingOutput = { requestId: string; messageId: string; output: "copy" | "insert"; originId: string | null };
export function LauncherConversation({ conversation, submission, pendingOutput, onRetry, onOutputApplied, onArchived, onSave, onOpenApp, handoffBusy = false }: { conversation: LauncherConversationBinding; onOpenApp: () => void; handoffBusy?: boolean; submission: { requestId: string; state: string; error?: string | null } | null; pendingOutput: PendingOutput | null; onRetry: () => void; onOutputApplied: () => void; onArchived: () => void; onSave: (text: string) => void }) {
  const { client, assistant, desktop, openInApp } = useLauncherShell();
  const cache = useQueryClient();
  const notify = useLauncherStore(state => state.notify);
  const visible = useLauncherStore(state => state.visible);
  const origin = useLauncherStore(state => state.origin);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const wasVisible = useRef(false);
  // A hidden panel stops polling; nothing animates or refreshes off screen.
  const snapshot = useQuery({ queryKey: ["launcher-snapshot", client.baseUrl, conversation.workspaceId, conversation.sessionId], queryFn: () => client.getSessionSnapshot(conversation.workspaceId, conversation.sessionId, { limit: 40 }), refetchInterval: visible ? 2500 : false, refetchOnWindowFocus: true });
  const own = useQuery({ queryKey: ["launcher-attention-own", client.baseUrl, conversation.conversationId], queryFn: () => client.assistantConversationAttention(conversation.conversationId), refetchInterval: visible ? 4000 : false });
  const delegated = useQuery({ queryKey: ["launcher-attention-delegated", client.baseUrl], queryFn: () => client.assistantAttentionAll(), refetchInterval: visible ? 5000 : false });
  // The server resolves this exact request across history pages and later turns.
  const automaticOutput = useQuery({ queryKey: ["launcher-request-output", client.baseUrl, pendingOutput?.requestId], queryFn: () => client.assistantSubmissionOutput(pendingOutput?.requestId ?? ""), enabled: Boolean(pendingOutput), refetchInterval: query => query.state.data && query.state.data.state !== "pending" ? false : 2500 });
  useEffect(() => onSyncPoke(poke => { if (poke.sessions || poke.approvals || poke.resync) { void snapshot.refetch(); void own.refetch(); void delegated.refetch(); } }), [snapshot, own, delegated]);
  const messages = useMemo(() => snapshot.data ? snapshotToUIMessages(snapshot.data.item) : [], [snapshot.data]);
  const status = snapshot.data?.item.status.type === "busy" ? "streaming" : snapshot.data?.item.status.type === "retry" ? "retrying" : "ready";
  const lastMessageTextSize = messages.at(-1)?.parts.flatMap(part => part.type === "text" ? [part.text.length] : []).join(",") ?? "";
  useEffect(() => {
    const body = rootRef.current?.closest<HTMLElement>(".launcher-body");
    if (!body) return;
    const onScroll = () => { followLatest.current = body.scrollHeight - body.scrollTop - body.clientHeight < 56; };
    body.addEventListener("scroll", onScroll);
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (!visible) { wasVisible.current = false; return; }
    if (!wasVisible.current) followLatest.current = true;
    wasVisible.current = true;
    if (!followLatest.current) return;
    const frame = requestAnimationFrame(() => { const body = rootRef.current?.closest<HTMLElement>(".launcher-body"); if (body) body.scrollTop = body.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [visible, conversation.conversationId, messages.length, lastMessageTextSize, status]);
  const attention = useMemo(() => [...new Map([...(own.data?.items ?? []), ...(delegated.data?.items ?? [])].filter(item => item.kind !== "widget").map(item => [item.id, item])).values()], [own.data, delegated.data]);
  // The last finished reply is what Copy, Insert and a quick action's output policy act on.
  const lastReply = useMemo(() => {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return null;
    const text = last.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
    return text ? { id: last.id, text } : null;
  }, [messages]);
  const copyReply = async (text: string) => {
    try { await copyLauncherText(text); notify({ tone: "info", text: t("launcher.notice.copied") }); }
    catch { notify({ tone: "error", text: t("launcher.notice.copy_failed") }); }
  };
  const insertReply = async (text: string, originId: string | null = origin?.id ?? null) => {
    try {
      if (!desktop || !originId) { await copyReply(text); return; }
      const result = await launcherOriginInsert(originId, text);
      if (result.ok) notify({ tone: "info", text: result.method === "paste" ? t("launcher.reply.inserted", { app: result.origin.app ?? "" }) : t("launcher.reply.copied_instead") });
      else notify({ tone: "error", text: result.copied ? t("launcher.reply.copied_instead") : result.message });
    } catch { notify({ tone: "error", text: t("launcher.notice.copy_failed") }); }
  };
  useEffect(() => {
    const answer = automaticOutput.data;
    if (!pendingOutput || !answer || answer.requestId !== pendingOutput.requestId || answer.messageId !== pendingOutput.messageId || answer.state === "pending") return;
    // Consume this automatic attempt once. A failed delivery offers manual Copy
    // or Insert again, without replaying a paste as snapshots keep arriving.
    onOutputApplied();
    if (answer.state === "failed") { notify({ tone: "error", text: answer.error }); return; }
    void (pendingOutput.output === "copy" ? copyReply(answer.text) : insertReply(answer.text, pendingOutput.originId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOutput, automaticOutput.data]);
  const archive = async () => {
    if (handoffBusy) return;
    try { await client.patchAssistantConversation(conversation.conversationId, { archived: true }); void cache.invalidateQueries({ queryKey: ["launcher-conversations"] }); notify({ tone: "info", text: t("launcher.conversation.archived") }); onArchived(); }
    catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  };
  const reply = async (item: AssistantAttentionItem, answer: { kind: "approval"; reply: "once" | "reject" } | { kind: "question"; answers: string[][] }) => {
    if (busy) return;
    setBusy(item.id);
    const input: AssistantAttentionReply = { id: item.id, revision: item.revision, workspaceId: item.workspaceId, sessionId: item.sessionId, ...answer };
    try {
      if (item.workspaceId === conversation.workspaceId && item.sessionId === conversation.sessionId) await client.replyAssistantConversationAttention(conversation.conversationId, input);
      else await client.replyAssistantAttention(input);
      notify({ tone: "info", text: t("assistant.attention_sent", { project: item.projectName }) });
    } catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : t("assistant.attention_failed") }); }
    finally { setBusy(null); await Promise.all([own.refetch(), delegated.refetch()]); void cache.invalidateQueries({ queryKey: ["launcher-work"] }); }
  };
  return <div ref={rootRef} className="launcher-conversation lw-session-typography">
    <div className="launcher-conversation-head"><span className="truncate">{conversation.title}</span>
      <Button size="sm" variant="ghost" disabled={handoffBusy} onClick={onOpenApp}>{t("launcher.result_action.open-in-app")}</Button>
      <Button size="icon-sm" variant="ghost" disabled={handoffBusy} aria-label={t("launcher.conversation.archive")} title={t("launcher.conversation.archive")} onClick={() => void archive()}><Archive className="size-3.5" /></Button>
    </div>
    <AttentionCards items={attention} busy={busy} onReply={reply} onOpen={item => openInApp(workspaceSessionRoute(item.workspaceId, item.sessionId))} />
    {snapshot.isError && <p role="alert" className="launcher-status"><AlertTriangle className="size-3.5" />{t("launcher.conversation.unavailable")} <button className="underline" onClick={() => void snapshot.refetch()}>{t("assistant.attention_retry")}</button></p>}
    <OpenTargetProvider openTargets={[]} onOpenTarget={() => openInApp(workspaceSessionRoute(conversation.workspaceId, conversation.sessionId))}>
      <MessageListProvider onCopyMessage={copyLauncherText} replyActionsMessageId={status === "ready" ? lastReply?.id : undefined} legalworkClient={client} workspaceId={conversation.workspaceId} sessionId={conversation.sessionId} readOnly assistantChat showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
        dispatchAction={() => openInApp("/settings/ai")} setPrompt={prompt => useLauncherStore.getState().setInput(prompt)} onRevertToUserMessage={() => undefined} onForkAtMessage={() => undefined} onEditUserMessage={() => undefined}>
        {snapshot.isPending ? <div className="launcher-status"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />{t("launcher.conversation.loading")}</div>
          : messages.length ? <MessageList showWelcome={false} messages={messages} status={status} /> : <p className="launcher-empty">{t("launcher.conversation.empty")}</p>}
      </MessageListProvider>
    </OpenTargetProvider>
    {lastReply && status === "ready" && <div className="launcher-reply-actions">
      <Button size="sm" variant="ghost" onClick={() => void copyReply(lastReply.text)}><Copy className="size-3.5" />{t("launcher.reply.copy")}</Button>
      <Button size="sm" variant="ghost" onClick={() => onSave(lastReply.text)}>{t("launcher.flow.save_reply")}</Button>
      {desktop && origin?.supportsInsert && <Button size="sm" variant="ghost" onClick={() => void insertReply(lastReply.text)}><ClipboardPaste className="size-3.5" />{t("launcher.reply.insert", { app: origin.app ?? "" })}</Button>}
    </div>}
    <SubmissionStatusRow submission={submission} onRetry={onRetry} />
  </div>;
}
