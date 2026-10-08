import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowUpRight, Bell, ChevronDown, Eye, EyeOff, Loader2, ShieldCheck, X } from "lucide-react";
import type { UIMessage } from "ai";
import type { AssistantAttentionItem, AssistantAttentionReply, AssistantProfile } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { PendingPermission, PendingQuestion } from "@/app/types";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { OpenTargetProvider } from "@/lib/target-provider";
import { t } from "@/i18n";
import { AssistantAvatar } from "./assistant-appearance";
import { QuestionPanel } from "../modals/question-modal";
import { PermissionApprovalPanel, permissionDetailRows } from "../chat/permission-approval-modal";
import { useComposerStateStore } from "../surface/composer-state-store";
import { widgetOutput } from "../sync/parse-tool-parts";

export function AssistantAttentionPanel({ client, profile, onOpenSession, permission, question, permissionBusy, questionBusy, onPermission, onQuestion }: {
  client: LegalworkServerClient; profile?: AssistantProfile;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  permission?: PendingPermission | null; question?: PendingQuestion | null;
  permissionBusy?: boolean; questionBusy?: boolean;
  onPermission?: (id: string, reply: "once" | "always" | "reject") => void;
  onQuestion?: (id: string, answers: string[][]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const query = useInfiniteQuery({ queryKey: ["assistant-attention-cards", client.baseUrl], initialPageParam: "",
    queryFn: ({ pageParam }) => client.assistantAttention(pageParam), getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 5000, refetchOnWindowFocus: true });
  const items = useMemo(() => [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).filter(item => item.presentation).map(item => [item.id, item])).values()], [query.data]);
  const visible = items.filter(item => item.visible);
  const hidden = items.filter(item => !item.visible);
  const pending = visible.filter(item => item.kind !== "widget").length + (permission ? 1 : 0) + (question ? 1 : 0);
  const signature = [permission?.id, question?.id, ...visible.map(item => `${item.id}:${item.revision}:${item.presentedAt}`)].filter(Boolean).join("|");
  const seen = useRef("");
  useEffect(() => {
    if (signature && signature !== seen.current) {
      const previous = seen.current.split("|");
      const added = signature.split("|").some(key => !previous.includes(key));
      if (added) setOpen(true);
    }
    seen.current = signature;
  }, [signature]);
  const act = async (id: string, action: () => Promise<unknown>, success?: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(id); setError(null); setReceipt(null);
    try { await action(); if (success) setReceipt(success); await query.refetch(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("assistant.attention_failed")); void query.refetch(); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const reply = (item: AssistantAttentionItem, answer: { kind: "approval"; reply: "once" | "reject" } | { kind: "question"; answers: string[][] }) => {
    const input: AssistantAttentionReply = { id: item.id, revision: item.revision, workspaceId: item.workspaceId, sessionId: item.sessionId, ...answer };
    void act(item.id, () => client.replyAssistantAttention(input), t("assistant.attention_sent", { project: item.projectName }));
  };
  if (!items.length && !permission && !question && !receipt && !error && !query.isError && !query.data?.pages.some(page => page.unavailable.length)) return null;
  return <div className="absolute right-3 top-3 z-30 max-w-[calc(100%-1.5rem)]" data-assistant-attention="">
    <div className="flex justify-end"><Button variant="outline" size="sm" className="rounded-full bg-background/90 shadow-sm backdrop-blur-md" aria-expanded={open} aria-controls="assistant-attention-panel" onClick={() => setOpen(value => !value)}>
      <Bell className="size-4" />{t("assistant.attention_title")}{pending > 0 && <span className="rounded-full bg-blue-9 px-1.5 text-xs text-white">{pending}</span>}<ChevronDown className={open ? "size-3 rotate-180" : "size-3"} />
    </Button></div>
    {open && <section id="assistant-attention-panel" aria-label={t("assistant.attention_title")} className="mt-2 flex max-h-[min(75dvh,720px)] w-[440px] max-w-full flex-col overflow-hidden rounded-3xl border border-border bg-background/95 shadow-xl backdrop-blur-xl">
      <header className="flex items-center gap-2 border-b px-4 py-3"><AssistantAvatar icon={profile?.icon ?? "dot"} className="size-7" /><div className="min-w-0 flex-1"><h2 className="text-sm font-medium">{profile?.name ?? t("assistant.title")}</h2><p className="text-xs text-muted-foreground">{t("assistant.attention_hint")}</p></div><Button size="icon-sm" variant="ghost" aria-label={t("common.close")} onClick={() => setOpen(false)}><X className="size-4" /></Button></header>
      <div className="space-y-3 overflow-y-auto overscroll-contain p-3">
        {(query.isError || query.data?.pages.some(page => page.unavailable.length)) && <p role="alert" className="text-sm text-destructive">{t("assistant.attention_unavailable")} <button className="underline" onClick={() => void query.refetch()}>{t("assistant.attention_retry")}</button></p>}
        {query.isPending && <Loader2 role="status" className="mx-auto size-4 animate-spin" />}
        {receipt && <p role="status" className="text-sm text-muted-foreground">{receipt}</p>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {permission && <div className="rounded-2xl border"><PermissionApprovalPanel permission={permission} busy={permissionBusy} respondPermission={onPermission} /></div>}
        {question && <div className="rounded-2xl border"><QuestionPanel questions={question.questions} busy={questionBusy ?? false} onReply={answers => onQuestion?.(question.id, answers)} /></div>}
        {visible.length === 0 && !permission && !question && !query.isPending && <p className="px-2 py-4 text-sm text-muted-foreground">{t("assistant.attention_empty")}</p>}
        {(showHidden ? items : visible).map(item => <article key={`${item.id}:${item.revision}`} className="overflow-hidden rounded-2xl border bg-background" data-attention-kind={item.kind}>
          <div className="flex items-start gap-2 border-b px-3 py-2.5"><div className="min-w-0 flex-1"><p className="text-xs font-medium text-muted-foreground">{item.projectName}</p><p className="break-words text-sm font-medium">{item.presentation?.title}</p><p className="mt-1 break-words text-sm text-muted-foreground">{item.presentation?.description}</p></div>
            <Button size="icon-sm" variant="ghost" aria-label={t("assistant.open_chat")} onClick={() => onOpenSession(item.workspaceId, item.sessionId)}><ArrowUpRight className="size-4" /></Button>
            <Button size="icon-sm" variant="ghost" disabled={!!busy} aria-label={t(item.visible ? "assistant.attention_hide" : "assistant.attention_show")} onClick={() => void act(item.id, () => client.setAssistantAttentionVisibility(item, !item.visible))}>{item.visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
          </div>
          {item.kind === "approval" ? <div className="space-y-3 p-3">
            <p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-blue-9" />{t("assistant.attention_approval")}</p>
            <p className="break-words text-sm">{item.permission}</p>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3 py-2 text-xs">{item.patterns.join("\n")}</pre>
            {permissionDetailRows(item.metadata).map(row => <div key={row.label}><p className="text-xs text-muted-foreground">{row.label}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{row.value}</pre></div>)}
            {Object.keys(item.metadata).length > 0 && <details className="text-xs"><summary className="cursor-pointer">{t("session.details_label")}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(item.metadata, null, 2)}</pre></details>}
            <div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={!!busy || query.isError} onClick={() => reply(item, { kind: "approval", reply: "reject" })}>{t("session.deny")}</Button><Button size="sm" disabled={!!busy || query.isError} onClick={() => reply(item, { kind: "approval", reply: "once" })}>{busy === item.id && <Loader2 className="size-3 animate-spin" />}{t("session.allow_once")}</Button></div>
          </div> : item.kind === "question" ? <QuestionPanel questions={item.questions} busy={!!busy || query.isError} onReply={answers => reply(item, { kind: "question", answers })} />
            : <div className="p-3"><AttentionWidget item={item} client={client} onOpenSession={onOpenSession} /></div>}
        </article>)}
        {hidden.length > 0 && <Button variant="ghost" size="sm" onClick={() => setShowHidden(value => !value)}>{t(showHidden ? "assistant.attention_less" : "assistant.attention_hidden", { count: hidden.length })}</Button>}
        {query.hasNextPage && <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t("assistant.attention_more")}</Button>}
      </div>
    </section>}
  </div>;
}

function AttentionWidget({ item, client, onOpenSession }: { item: Extract<AssistantAttentionItem, { kind: "widget" }>; client: LegalworkServerClient; onOpenSession: (workspaceId: string, sessionId: string) => void }) {
  const open = () => onOpenSession(item.workspaceId, item.sessionId);
  const message: UIMessage = { id: item.messageId, role: "assistant", parts: [{ type: "dynamic-tool", toolCallId: item.toolCallId, toolName: item.toolName, state: "output-available", input: item.input, output: widgetOutput(item.output) }] };
  return <OpenTargetProvider openTargets={[]} onOpenTarget={open}><MessageListProvider legalworkClient={client} workspaceId={item.workspaceId} sessionId={item.sessionId} readOnly showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0} dispatchAction={open}
    setPrompt={prompt => { useComposerStateStore.getState().setDraft(item.sessionId, prompt); open(); }} onRevertToUserMessage={open} onForkAtMessage={open} onEditUserMessage={open}>
    <MessageList showWelcome={false} messages={[message]} status="ready" />
  </MessageListProvider></OpenTargetProvider>;
}
