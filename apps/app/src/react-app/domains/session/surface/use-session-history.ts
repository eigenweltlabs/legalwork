import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { UIMessage } from "ai";
import type { LegalworkServerClient, LegalworkSessionSnapshot } from "@/app/lib/legalwork-server";
import { resolvePagedForkBoundaryId } from "../sync/transcript-reconcile";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { getSessionScrollState, useSessionScrollStore } from "./scroll-store";
import { captureHistoryAnchor, restoreHistoryAnchor, nearbyHistoryBatches, historyBatchMessages, HISTORY_BATCH_SIZE, type HistoryAnchor, type HistoryBatch } from "./history-window";

function batchOf(snapshot: LegalworkSessionSnapshot, date?: string): HistoryBatch {
  return { count: snapshot.messages.length, ...snapshot.historyPage, sessionId: snapshot.session.id, date, messages: snapshotToUIMessages(snapshot) };
}

function includesLatest(batches: HistoryBatch[], live: UIMessage[], sessionId: string) {
  const latest = live.at(-1);
  const tail = batches.at(-1);
  return Boolean(latest && tail?.sessionId === sessionId && tail.messages.some(message => message.id === latest.id));
}

/** Frozen pages while reading history; live messages continue in their small shared cache. */
export function useSessionHistory(input: {
  client: LegalworkServerClient; workspaceId: string; sessionId: string;
  snapshot: LegalworkSessionSnapshot | null; live: UIMessage[]; containerRef: RefObject<HTMLDivElement | null>;
  assistantDate?: string;
}) {
  const scope = `${input.client.baseUrl}:${input.workspaceId}:${input.sessionId}`;
  const [state, setState] = useState<{ scope: string; batches: HistoryBatch[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"older" | "newer" | null>(null);
  const [latestRevision, setLatestRevision] = useState(0);
  const batches = state?.scope === scope ? state.batches : null;
  const current = useRef({ input, batches, scope });
  current.current = { input, batches, scope };
  const pending = useRef<AbortController | null>(null);
  const anchor = useRef<HistoryAnchor | null>(null);
  const adjusting = useRef(false);
  const latestReady = useRef<(() => void) | null>(null);

  const revertId = input.snapshot?.session.revert?.messageID;
  useEffect(() => () => { pending.current?.abort(); pending.current = null; latestReady.current = null; }, [scope, revertId]);
  useEffect(() => { setState(null); setLoading(false); setError(null); }, [scope, revertId]);

  const replace = useCallback((next: HistoryBatch[]) => {
    const { input, scope } = current.current;
    const container = input.containerRef.current;
    if (container) {
      adjusting.current = true;
      anchor.current = captureHistoryAnchor(container, new Set(next.flatMap(batch => batch.messages.map(message => message.id))));
      container.style.overflowAnchor = "none";
      useSessionScrollStore.getState().setManualScroll(input.sessionId, container.scrollTop, null);
    }
    setState({ scope, batches: next });
  }, []);

  useLayoutEffect(() => {
    const container = input.containerRef.current;
    if (!container || !adjusting.current) return;
    adjusting.current = false;
    if (anchor.current) restoreHistoryAnchor(container, anchor.current);
    anchor.current = null;
    useSessionScrollStore.getState().setManualScroll(input.sessionId, container.scrollTop, null);
    container.style.overflowAnchor = "auto";
  }, [batches, input.containerRef, input.sessionId]);

  const latest = useCallback((onReady: () => void) => {
    pending.current?.abort(); pending.current = null;
    anchor.current = null;
    adjusting.current = false;
    latestReady.current = onReady;
    current.current.batches = null;
    setState(null); setLoading(false); setError(null);
    setLatestRevision(revision => revision + 1);
  }, []);

  useLayoutEffect(() => {
    if (batches || !latestReady.current) return;
    latestReady.current();
    latestReady.current = null;
  }, [batches, latestRevision]);

  const load = useCallback(async (direction: "older" | "newer") => {
    const { input, batches, scope } = current.current;
    if (latestReady.current || pending.current || !input.snapshot?.historyPage) return;
    const existing = batches ?? [batchOf(input.snapshot, input.assistantDate)];
    // Native cursors can point past the end. The live tail already tells us
    // that this window contains the newest message, so no probe is needed.
    if (direction === "newer" && includesLatest(existing, input.live, input.sessionId)) return;
    const edge = direction === "older" ? existing[0] : existing.at(-1);
    if (!edge || direction === "older" && edge.startReached) return;
    let cursor = direction === "older" ? edge.olderCursor : edge.newerCursor;
    if (!cursor && !input.assistantDate) return;
    let sessionId = edge.sessionId ?? input.sessionId;
    let date = edge.date;
    let order = edge.order ?? "desc";
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(null);
    try {
      const seen = new Set<string>();
      while (true) {
        const key = `${sessionId}:${order}:${cursor ?? ""}`;
        if (seen.has(key)) throw new Error("Repeated history cursor");
        seen.add(key);
        const result = (await input.client.getSessionSnapshot(input.workspaceId, sessionId, {
          page: true, cursor, pageOrder: order, limit: HISTORY_BATCH_SIZE, fileReferences: true, signal: controller.signal,
        })).item;
        if (controller.signal.aborted || scope !== current.current.scope) return;
        const page = batchOf(result, date);
        if (page.count > 0) {
          if (page.messages.length > 0) { replace(nearbyHistoryBatches(existing, page, direction)); return; }
          cursor = direction === "older" ? page.olderCursor : page.newerCursor;
          if (cursor) continue;
        }
        // The Assistant's daily engine contexts are one bounded, continuous timeline.
        if (input.assistantDate && date) {
          const days = await input.client.mainAssistantHistory(direction === "older" ? date : undefined, 1, direction === "newer" ? date : undefined);
          if (controller.signal.aborted || scope !== current.current.scope) return;
          const day = days.days[0];
          if (day && day.date <= input.assistantDate) {
            sessionId = day.sessionId; date = day.date; cursor = undefined;
            order = direction === "older" ? "desc" : "asc";
            continue;
          }
        }
        if (direction === "newer") {
          const snapshot = current.current.input.snapshot;
          if (snapshot) replace([batchOf(snapshot, input.assistantDate)]);
          setState(null);
        } else replace(existing.map((batch, index) => index === 0 ? { ...batch, olderCursor: undefined, startReached: true } : batch));
        return;
      }
    } catch {
      if (!controller.signal.aborted) setError(direction);
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [replace]);

  const onScroll = useCallback(() => {
    const { input, batches, scope } = current.current;
    const container = input.containerRef.current;
    if (latestReady.current || !container || !input.snapshot?.historyPage) return;
    const atLatest = batches && includesLatest(batches, input.live, input.sessionId);
    if (atLatest && container.scrollHeight - container.clientHeight - container.scrollTop <= 8) return true;
    const manual = getSessionScrollState(useSessionScrollStore.getState().sessions, input.sessionId).mode === "manual";
    if (!batches && manual) setState({ scope, batches: [batchOf(input.snapshot, input.assistantDate)] });
    if (batches) useSessionScrollStore.getState().setManualScroll(input.sessionId, container.scrollTop, null);
    if (container.scrollTop < 240 && manual) void load("older");
    else if (batches && !atLatest && container.scrollHeight - container.clientHeight - container.scrollTop < 240) void load("newer");
  }, [load]);

  const find = useCallback(async (messageId: string) => {
    const { input, scope } = current.current;
    if (!input.snapshot) return false;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(null);
    let pages = [batchOf(input.snapshot, input.assistantDate)];
    const seen = new Set<string>();
    try {
      while (!pages.some(page => page.messages.some(message => message.id === messageId))) {
        const cursor = pages[0]?.olderCursor;
        if (!cursor || seen.has(cursor)) return false;
        seen.add(cursor);
        const snapshot = (await input.client.getSessionSnapshot(input.workspaceId, input.sessionId, {
          page: true, cursor, limit: HISTORY_BATCH_SIZE, fileReferences: true, signal: controller.signal,
        })).item;
        if (controller.signal.aborted || scope !== current.current.scope) return false;
        const page = batchOf(snapshot, input.assistantDate);
        if (page.count === 0) return false;
        pages = nearbyHistoryBatches(pages, page, "older");
      }
      replace(pages);
      return true;
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [replace]);

  const forkBoundary = useCallback(async (messageId: string) => {
    const { input, batches, scope } = current.current;
    const tail = batches?.at(-1) ?? (input.snapshot ? batchOf(input.snapshot) : undefined);
    let cursor = tail?.newerCursor;
    const seen = new Set<string>();
    return resolvePagedForkBoundaryId(batches ? historyBatchMessages(batches, input.live) : input.live, messageId, async () => {
      if (!cursor) return null;
      if (seen.has(cursor)) throw new Error("Repeated history cursor");
      seen.add(cursor);
      const snapshot = (await input.client.getSessionSnapshot(input.workspaceId, input.sessionId, {
        page: true, cursor, pageOrder: tail?.order, limit: HISTORY_BATCH_SIZE, fileReferences: true,
      })).item;
      if (scope !== current.current.scope) throw new Error("Chat changed while branching");
      cursor = snapshot.historyPage?.newerCursor;
      return snapshot.historyPage?.count === 0 ? null : snapshotToUIMessages(snapshot);
    });
  }, []);

  const messages = useMemo(() => batches ? historyBatchMessages(batches, input.live) : input.live, [batches, input.live]);
  const sections = useMemo(() => {
    const sections: { sessionId: string; date?: string; messages: UIMessage[] }[] = [];
    for (const batch of batches ?? []) {
      const sessionId = batch.sessionId ?? input.sessionId;
      let section = sections.at(-1);
      if (!section || section.sessionId !== sessionId) {
        section = { sessionId, date: batch.date, messages: [] }; sections.push(section);
      }
      section.messages.push(...historyBatchMessages([batch], input.live));
    }
    return sections;
  }, [batches, input.live, input.sessionId]);
  return { messages, sections, loading, error, retry: () => error && void load(error), onScroll, load, latest, find, forkBoundary, browsing: Boolean(batches) };
}
