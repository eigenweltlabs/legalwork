/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";

import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import type { ThreadStatus } from "@/lib/messages";
import { OpenTargetProvider } from "@/lib/target-provider";
import type { LegalworkSessionSnapshot } from "../../../app/lib/legalwork-server";
import { deriveOpenTargets, type OpenTarget } from "../session/artifacts/open-target";
import { LEARNINGS_PANEL_SESSION_ID, usePanelTabStore } from "../session/panel/panel-tab-store";
import { snapshotToUIMessages } from "../session/sync/usechat-adapter";
import { SettingsNotice, Spinner } from "../settings/settings-section";
import { isItemActive } from "./format";
import { getBenchmarkContext, useBenchmarkStore } from "./store";

const TRANSCRIPT_POLL_MS = 3_000;

export type SessionTranscriptScreenProps = {
  runId: string;
  itemId: string;
  onBack: () => void;
};

/**
 * The normal full-screen chat layout for a benchmark agent session: the same
 * MessageList the session page uses, filling the pane, with the composer
 * pinned at the bottom but permanently disabled. Polls while the session is
 * still busy so live runs stream in.
 */
export function SessionTranscriptScreen(props: SessionTranscriptScreenProps) {
  const activeRun = useBenchmarkStore((state) => state.activeRun);
  const loadRun = useBenchmarkStore((state) => state.loadRun);
  const [snapshot, setSnapshot] = useState<LegalworkSessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeRun?.run.id !== props.runId) void loadRun(props.runId);
  }, [props.runId, activeRun?.run.id, loadRun]);

  const item = activeRun?.run.id === props.runId
    ? activeRun.items.find((entry) => entry.id === props.itemId) ?? null
    : null;
  const sessionId = item?.sessionId ?? null;
  const itemActive = item ? isItemActive(item.status) : false;

  useEffect(() => {
    setSnapshot(null);
    setError(null);
  }, [sessionId]);

  // Live updates keyed on the ITEM lifecycle, not the snapshot's session
  // status: the server resolves session status directory-scoped to the
  // workspace root, and benchmark sessions live in scratch dirs, so their
  // status always reads "idle" there. While the item is pending/running/
  // judging we refresh both the run (item status) and the transcript.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = async () => {
      const ctx = getBenchmarkContext();
      if (!ctx || cancelled) return;
      try {
        const { item: loaded } = await ctx.client.getSessionSnapshot(ctx.workspaceId, sessionId, { limit: 500 });
        if (!cancelled) {
          setSnapshot(loaded);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = itemActive
      ? setInterval(() => {
          void loadRun(props.runId);
          void load();
        }, TRANSCRIPT_POLL_MS)
      : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [sessionId, itemActive, props.runId, loadRun]);

  const ctx = getBenchmarkContext();
  const status: ThreadStatus = itemActive ? "streaming" : "ready";
  const messages = useMemo(() => (snapshot ? snapshotToUIMessages(snapshot) : []), [snapshot]);
  // Same target derivation as the session surface — makes artifact chips resolvable.
  const openTargets = useMemo(
    () => deriveOpenTargets(messages).map((target) => ({ ...target, exists: true })),
    [messages],
  );

  // File chips in the transcript reference paths inside the agent's scratch
  // dir; remap to workspace-relative and open them in the right-rail viewer.
  const scratchPrefix = `.legalwork/benchmarks/${props.runId}/${props.itemId}/`;
  const handleOpenTarget = (target: OpenTarget) => {
    if (target.kind !== "file") return;
    const value = target.value.startsWith(".legalwork/")
      ? target.value
      : `${scratchPrefix}${target.value.replace(/^\.\//, "")}`;
    const resolved: OpenTarget = { ...target, value, id: `file:${value.toLowerCase()}`, exists: true };
    const panelStore = usePanelTabStore.getState();
    const existing = panelStore.transcriptArtifactTargets[LEARNINGS_PANEL_SESSION_ID] ?? [];
    panelStore.syncTranscriptArtifacts(LEARNINGS_PANEL_SESSION_ID, [
      ...existing.filter((entry) => entry.id !== resolved.id),
      resolved,
    ]);
    window.dispatchEvent(new CustomEvent("legalwork-open-accessible-target", { detail: resolved }));
  };

  // Escape the settings surface padding so the chat fills the pane edge to
  // edge, exactly like the session view.
  return (
    <div className="-m-4 flex min-h-0 min-w-0 flex-1 flex-col self-stretch md:-m-6 lg:-m-8">
      {error || (item && !item.sessionId) ? (
        <div className="px-4 pt-3">
          {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
          {item && !item.sessionId ? (
            <SettingsNotice tone="error">{t("benchmark.no_session")}</SettingsNotice>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!snapshot && !error ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : null}
        {snapshot && ctx && sessionId ? (
          <MessageListProvider
            workspaceId={ctx.workspaceId}
            sessionId={sessionId}
            showThinking
            developerMode={false}
            displaySuggestions={false}
            providerConnectedCount={0}
            dispatchAction={() => undefined}
            setPrompt={() => undefined}
            onRevertToUserMessage={() => undefined}
            onForkAtMessage={() => undefined}
            onEditUserMessage={() => undefined}
          >
            <OpenTargetProvider openTargets={openTargets} onOpenTarget={handleOpenTarget}>
              <MessageList
                messages={messages}
                status={status}
                retryStatus={snapshot.status.type === "retry" ? snapshot.status : null}
              />
            </OpenTargetProvider>
          </MessageListProvider>
        ) : null}
      </div>

      {/* Read-only: the normal composer slot, pinned like the session view, permanently disabled. */}
      <div className="shrink-0 border-t border-border bg-background p-3">
        <div className="mx-auto w-full max-w-[720px]">
          <Textarea
            disabled
            rows={2}
            className="resize-none"
            placeholder={t("benchmark.transcript_readonly")}
          />
        </div>
      </div>
    </div>
  );
}
