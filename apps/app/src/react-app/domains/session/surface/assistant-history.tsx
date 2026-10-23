import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { AssistantOnboardingState } from "@legalwork/types/main-assistant";
import { AssistantOnboardingConversation } from "./assistant-onboarding-conversation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { OpenTargetProvider, type OpenTargetOptions } from "@/lib/target-provider";
import { deriveOpenTargets, type OpenTarget } from "../artifacts/open-target";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { getSessionScrollState, useSessionScrollStore } from "./scroll-store";

export function AssistantDateDivider({ date }: { date: string }) {
  const locale = useLocale();
  const label = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(`${date}T12:00:00`));
  return <div className="flex items-center gap-3 py-6 text-[11px] text-muted-foreground" data-assistant-date={date}><span className="h-px flex-1 bg-border" /><time dateTime={date}>{label}</time><span className="h-px flex-1 bg-border" /></div>;
}

/** Older engine contexts are rendered here only. They never enter today's prompt or transcript cache. */
export function AssistantHistory({ client, workspaceId, sessionId, date, scrollRef, onOpenTarget, onboarding }: {
  client: LegalworkServerClient; workspaceId: string; sessionId: string; date: string; scrollRef: RefObject<HTMLDivElement | null>;
  onOpenTarget?: (target: OpenTarget, options?: OpenTargetOptions) => void;
  onboarding?: AssistantOnboardingState;
}) {
  const anchor = useRef<{ top: number; height: number } | null>(null);
  const history = useInfiniteQuery({
    queryKey: ["assistant-history", client.baseUrl, workspaceId, date],
    initialPageParam: date,
    queryFn: async ({ pageParam }) => {
      const page = await client.mainAssistantHistory(pageParam, 1);
      const days = await Promise.all(page.days.map(async day => {
        const snapshot = (await client.getSessionSnapshot(workspaceId, day.sessionId)).item;
        const messages = snapshotToUIMessages(snapshot);
        const targets = deriveOpenTargets(messages);
        const openTargets: OpenTarget[] = targets.length ? await client.resolveArtifacts(workspaceId, targets)
          .then(result => result.items).catch(() => targets.map(target => ({ ...target, exists: target.kind === "url" }))) : [];
        return { ...day, snapshot, messages, openTargets };
      }));
      return { days, nextBefore: page.nextBefore };
    },
    getNextPageParam: page => page.nextBefore ?? undefined,
    staleTime: 30_000,
    // A turn started yesterday can finish after midnight.
    refetchInterval: query => query.state.data?.pages.some(page => page.days.some(day => day.snapshot.status.type !== "idle")) ? 5000 : false,
  });
  const loadOlder = useCallback(() => {
    if (!history.hasNextPage || history.isFetching || history.isError) return;
    const container = scrollRef.current;
    if (container) anchor.current = { top: container.scrollTop, height: container.scrollHeight };
    void history.fetchNextPage();
  }, [history.hasNextPage, history.isFetching, history.isError, history.fetchNextPage, scrollRef]);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !anchor.current || history.isFetching) return;
    container.scrollTop = anchor.current.top + container.scrollHeight - anchor.current.height;
    useSessionScrollStore.getState().setManualScroll(sessionId, container.scrollTop, null);
    anchor.current = null;
  }, [history.data, history.isFetching, scrollRef, sessionId]);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const load = () => {
      if (container.scrollTop < 240 && getSessionScrollState(useSessionScrollStore.getState().sessions, sessionId).mode === "manual") loadOlder();
    };
    container.addEventListener("scroll", load);
    load();
    return () => container.removeEventListener("scroll", load);
  }, [loadOlder, scrollRef, sessionId]);
  const days = history.data?.pages.flatMap(page => page.days).toReversed() ?? [];
  return <>
    {history.isFetching && <p role="status" className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{t("assistant.loading_history")}</p>}
    {history.isError && <div role="alert" className="py-3 text-center text-xs text-muted-foreground">{t("assistant.history_failed")}<Button variant="ghost" size="sm" onClick={() => void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())}>{t("scheduled.retry")}</Button></div>}
    {history.hasNextPage && !history.isFetching && <Button variant="ghost" size="sm" className="mx-auto block text-xs text-muted-foreground" onClick={loadOlder}>{t("assistant.older")}</Button>}
    {days.map((day, index) => <section key={day.sessionId} aria-label={day.date}>
      {(index > 0 || history.hasNextPage) && <AssistantDateDivider date={day.date} />}
      {onboarding?.step === "complete" && onboarding.sessionId === day.sessionId && <AssistantOnboardingConversation workspaceId={workspaceId} state={onboarding} />}
      <OpenTargetProvider openTargets={day.openTargets} onOpenTarget={onOpenTarget}>
      <MessageListProvider assistantChat legalworkClient={client} workspaceId={workspaceId} sessionId={day.sessionId} readOnly showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
        dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}>
        <MessageList messages={day.messages} status="ready" showWelcome={false} />
      </MessageListProvider>
      </OpenTargetProvider>
    </section>)}
    {days.length > 0 && <AssistantDateDivider date={date} />}
  </>;
}
