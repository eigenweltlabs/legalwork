/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { Check, Minimize2, TriangleAlert } from "lucide-react";
import { toast } from "@/components/ui/sonner";

import { analyticsSurface, captureAnalyticsEvent } from "@/app/lib/analytics";
import { analyticsErrorService, analyticsErrorStatus } from "@/app/lib/analytics-error";
import {
  EIGENWELT_FREE_LIMIT_ERROR_TEXT,
  eigenweltFreeBudgetRetryAction,
  isEigenweltFreeBudgetError,
  markEigenweltFreeBudgetStop,
  shouldStopEigenweltFreeBudgetRetry,
} from "@/app/lib/eigenwelt-free-budget";
import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSessionSafe } from "@/app/lib/opencode-session";
import { isOfficeAddinRuntime } from "@/app/lib/runtime-env";
import { t } from "@/i18n";
import { readWorkspaceImports, type ImportedPlugin } from "@/app/lib/extension-imports";
import type {
  LegalworkServerClient,
  LegalworkSessionSnapshot,
} from "@/app/lib/legalwork-server";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  McpServerEntry,
  McpStatusMap,
  ModelRef,
  PendingPermission,
  PendingQuestion,
  SkillCard,
  TodoItem,
} from "@/app/types";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "@/app/lib/app-inspector";
import { useControlAction, type LegalworkControlAction } from "@/react-app/shell/control/control-provider";
import { ReactSessionComposer } from "./composer/composer";
import { decodeComposerMentionValue, encodeComposerMentionValue, type ComposerMentionKind } from "./composer/mention-encoding";
import { desktopBridge } from "@/app/lib/desktop";
import { parseSlashCommandInvocation } from "./composer/slash-command";
import { DevProfiler } from "@/react-app/shell/dev-profiler";
import { PaperGrainGradient } from "@legalwork/ui/react";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { useReactRenderWatchdog } from "@/react-app/shell/react-render-watchdog";
import { SessionDebugPanel } from "./debug-panel";
import { deriveRenderedSessionMessages, resolveRenderedSessionSnapshot } from "./session-render-state";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useRecorderStore } from "@/react-app/domains/recorder/recorder-store";
import { isModelReadableAttachment } from "@/react-app/domains/session/sync/attachment-support";
import { deriveSessionRenderModel } from "@/react-app/domains/session/sync/transition-controller";
import { useSessionScrollController } from "./scroll-controller";
import { SessionScrollOverlay } from "./scroll-overlay";
import { getSessionActivityStatusLabel, useSessionActivityStore, type SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store";
import { PermissionApprovalPanel } from "@/react-app/domains/session/chat/permission-approval-modal";
import { QuestionPanel } from "@/react-app/domains/session/modals/question-modal";
import { QueuedMessagesPanel } from "@/react-app/domains/session/modals/queued-messages-panel";
import { deriveOpenTargets, selectAutoOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store";
import {
  injectSessionErrorMessage,
  seedSessionState,
  snapshotKey as reactSnapshotKey,
  statusKey as reactStatusKey,
  transcriptKey as reactTranscriptKey,
} from "@/react-app/domains/session/sync/session-sync";
import { resolveForkBoundaryId } from "@/react-app/domains/session/sync/transcript-reconcile";
import {
  getComposerAttachments,
  getComposerDraft,
  getComposerHistory,
  getComposerMentions,
  getComposerPasteParts,
  getComposerQueuedDrafts,
  useComposerStateStore,
} from "./composer-state-store";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider, type DispatchAction } from "@/components/chat/message-list-provider";
import { FusionIntroDialog, markFusionIntroSeen, shouldShowFusionIntro } from "@/react-app/domains/session/fusion/fusion-intro-dialog";
import { useFusionStore } from "@/react-app/domains/session/fusion/fusion-store";
import { OpenTargetProvider, type OpenTargetOptions } from "@/lib/target-provider";
import type { ThreadStatus } from "@/lib/messages";
import {
  EnvironmentVariableProvider,
  type ApplyEnvironmentChangesResult,
} from "@/react-app/domains/settings/pages/environment-variable-provider";

const EMPTY_TRANSCRIPT: UIMessage[] = [];
const IDLE_STATUS: SessionStatus = { type: "idle" };
const DEFAULT_COMPOSER_CONTROL_TEXT = "Help me outline the next LegalWork task.";

type SessionError = {
  message: string;
  kind?: "model-not-found" | "generic";
  /** For model-not-found: the model that failed. */
  failedModel?: { providerID: string; modelID: string };
  /** For model-not-found: suggested replacements from the backend. */
  suggestions?: Array<{ providerID: string; modelID: string }>;
};

export type SessionSurfaceProps = {
  client: LegalworkServerClient;
  environmentClient?: LegalworkServerClient | null;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  opencodeBaseUrl: string;
  legalworkToken: string;
  developerMode: boolean;
  modelLabel: string;
  onModelClick: () => void;
  modelPickerOpen: boolean;
  modelUnavailable?: boolean;
  selectedModel: ModelRef;
  /** True when the active model is a free-tier model (no-key fallback). */
  freeModelSelected?: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef) => void;
  onSendDraft: (draft: ComposerDraft, sessionId: string) => void;
  onDraftChange: (draft: ComposerDraft) => void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<import("@opencode-ai/sdk/v2/client").Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<import("@/app/types").SlashCommandOption[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  todos?: TodoItem[];
  activePermission?: PendingPermission | null;
  permissionReplyBusy?: boolean;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject") => void;
  activeQuestion?: PendingQuestion | null;
  questionReplyBusy?: boolean;
  respondQuestion?: (requestID: string, answers: string[][]) => void;
  safeStringify?: (value: unknown) => string;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onUploadInboxFiles?: ((files: File[], options?: { notify?: boolean }) => void | Promise<unknown>) | null;
  providerConnectedCount?: number;
  onOpenSettingsSection?: ((section: "commands" | "skills" | "mcps" | "plugins" | "providers") => void) | undefined;
  onRevertToMessage?: (messageId: string, sessionId: string) => Promise<boolean>;
  onForkAtMessage?: (messageId: string | null, sessionId: string) => void;
  onOpenTarget?: (target: OpenTarget, options?: OpenTargetOptions, sessionId?: string) => void;
  environmentRuntimeKey?: string | null;
  onApplyEnvironmentChanges?: () => Promise<ApplyEnvironmentChangesResult>;
};

function messageToReadableText(message: UIMessage) {
  const header = message.role === "user" ? "You" : message.role === "assistant" ? "LegalWork" : message.role;
  const body = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "reasoning") return [part.text];
      if (part.type === "dynamic-tool") {
        if (part.state === "output-error") return [`[tool:${part.toolName}] ${part.errorText}`];
        if (part.state === "output-available") return [`[tool:${part.toolName}] ${JSON.stringify(part.output)}`];
        return [`[tool:${part.toolName}] ${JSON.stringify(part.input)}`];
      }
      return [];
    })
    .join("\n\n");
  return `${header}\n${body}`.trim();
}

function transcriptToText(messages: UIMessage[]) {
  return messages
    .flatMap((message) => {
      const text = messageToReadableText(message);
      return text ? [text] : [];
    })
    .join("\n\n---\n\n");
}

function statusLabel(snapshot: LegalworkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return "Running...";
  if (snapshot?.status.type === "busy") return "Running...";
  if (snapshot?.status.type === "retry") return `Retrying: ${snapshot.status.message}`;
  return "Ready";
}

function controlTextArgument(args: unknown) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object" && "text" in args) {
    const text = (args as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return DEFAULT_COMPOSER_CONTROL_TEXT;
}

const waitForControl = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function useSharedQueryState<T>(queryKey: readonly unknown[], fallback: T) {
  const query = useQuery<T, Error, T, readonly unknown[]>({
    queryKey,
    queryFn: async () => fallback,
    enabled: false,
  });
  return query.data ?? fallback;
}

function messageHasVisibleAssistantOutput(message: UIMessage) {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

function AssistantWaitingCard({ label = t("session.assistant_thinking") }: { label?: string }) {
  return (
    <div className="flex justify-start" role="status" aria-live="polite">
      <div className="inline-flex items-center gap-1.5 px-1 py-1 text-[12px] text-dls-secondary">
        <div style={{ width: 20, height: 20, borderRadius: "50%", overflow: "hidden" }}>
          <PaperGrainGradient
            speed={12}
            softness={0.1}
            intensity={1}
            noise={0.05}
            shape="sphere"
            colors={["#818cf8", "#fb7185", "#fbbf24", "#34d399"]}
            colorBack="#ffffff00"
            style={{ backgroundColor: "#818cf8", width: "100%", height: "100%", borderRadius: "50%" }}
          />
        </div>
        <span>{label}</span>
      </div>
    </div>
  );
}

function TodoPanel(props: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const todos = props.todos.filter((todo) => todo.content.trim());
  const completedTodos = todos.filter((todo) => todo.status === "completed").length;
  const progressLabel = t("session.todo_progress_label");
  const label = expanded ? progressLabel : `${progressLabel} · ${completedTodos}/${todos.length}`;

  if (todos.length === 0) return null;

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50"
          onClick={() => setExpanded((current) => !current)}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-11">{label}</span>
          </div>
          <Minimize2 size={12} className={`text-gray-8 transition-transform ${expanded ? "" : "rotate-180"}`} />
        </button>
        {expanded ? (
          <div className="max-h-60 space-y-2.5 overflow-auto border-t border-dls-border px-4 pb-3">
            {todos.map((todo, index) => {
              const done = todo.status === "completed";
              const cancelled = todo.status === "cancelled";
              const active = todo.status === "in_progress";
              return (
                <div key={todo.id} className="flex items-start gap-2.5 pt-2.5 first:pt-2.5">
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <div
                      className={`flex size-4.5 items-center justify-center rounded-full border ${
                        done
                          ? "border-green-6 bg-green-2 text-green-11"
                          : active
                            ? "border-amber-6 bg-amber-2 text-amber-11"
                            : cancelled
                              ? "border-gray-6 bg-gray-2 text-gray-8"
                              : "border-gray-6 bg-gray-1 text-gray-8"
                      }`}
                    >
                      {done ? <Check size={10} /> : active ? <span className="size-1.5 rounded-full bg-amber-9" /> : null}
                    </div>
                  </div>
                  <div className={`flex-1 text-sm leading-relaxed ${cancelled ? "text-gray-9 line-through" : "text-gray-12"}`}>
                    <span className="mr-1.5 text-gray-9">{index + 1}.</span>
                    {todo.content}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
    </div>
  );
}

/**
 * Banner shown above the composer whenever the active model is a free model
 * (the no-key fallback, served by Eigenwelt's free gateway). Free-tier usage
 * data is logged, so free models are for testing only — never for
 * privileged, client, or matter data.
 */
function FreeModelNotice() {
  return (
    <div className="flex items-start gap-2.5 border-b border-dls-border bg-amber-2/40 px-4 py-3">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-11" />
      <p className="text-xs leading-relaxed text-amber-11">
        <span className="font-medium">Free test model.</span>{" "}
        Lower-quality, and zero data retention is not guaranteed. Don&apos;t use
        it with client or matter data. Connect your own model for real work.
      </p>
    </div>
  );
}

function parseSessionError(thrown: unknown): SessionError {
  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  // Try to detect ProviderModelNotFoundError from the SDK error shape.
  // The error message may be a JSON string from our serializer in session-route.
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.name === "ProviderModelNotFoundError" && parsed?.data) {
      const { providerID, modelID, suggestions } = parsed.data;
      return {
        message: `Model ${providerID}/${modelID} is not available.`,
        kind: "model-not-found",
        failedModel: { providerID, modelID },
        suggestions: Array.isArray(suggestions) ? suggestions : [],
      };
    }
  } catch {
    // Not JSON — fall through to plain message
  }
  // Check if the raw string mentions model-not-found patterns
  if (/ProviderModelNotFoundError/i.test(raw) || /model.*not found/i.test(raw)) {
    return { message: raw, kind: "model-not-found" };
  }
  return { message: raw || "Failed to send prompt." };
}

function SessionErrorCard({ error, onDismiss, onChangeModel, onOpenModelPicker }: {
  error: SessionError;
  onDismiss: () => void;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onOpenModelPicker?: () => void;
}) {
  return (
    <div className="mx-auto max-w-[720px] px-3 py-3 sm:px-5">
      <div className="rounded-2xl border border-red-6/30 bg-red-3/15 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-red-11">{error.message}</div>
            {error.kind === "model-not-found" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {error.suggestions && error.suggestions.length > 0 ? (
                  error.suggestions.map((s) => (
                    <button
                      key={`${s.providerID}/${s.modelID}`}
                      type="button"
                      className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                      onClick={() => {
                        onChangeModel?.(s);
                        onDismiss();
                      }}
                    >
                      Use {s.providerID}/{s.modelID}
                    </button>
                  ))
                ) : null}
                <button
                  type="button"
                  className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    onOpenModelPicker?.();
                    onDismiss();
                  }}
                >
                  Change model
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-red-10 transition-colors hover:bg-red-3 hover:text-red-11"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function revokeAttachmentPreview(attachment: { previewUrl?: string | undefined }) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
}

// Combine multiple queued follow-up drafts into a single send. Their text and
// parts are concatenated with blank-line separators and attachments are
// merged, so the whole queue is delivered to the agent as one message.
function mergeDrafts(drafts: ComposerDraft[]): ComposerDraft | null {
  if (drafts.length === 0) return null;
  if (drafts.length === 1) return drafts[0] ?? null;
  const separator: ComposerPart = { type: "text", text: "\n\n" };
  const parts: ComposerPart[] = [];
  const attachments: ComposerAttachment[] = [];
  const texts: string[] = [];
  const resolvedTexts: string[] = [];
  drafts.forEach((draft, index) => {
    if (index > 0) parts.push(separator);
    parts.push(...draft.parts);
    attachments.push(...draft.attachments);
    texts.push(draft.text);
    resolvedTexts.push(draft.resolvedText ?? draft.text);
  });
  return {
    mode: "prompt",
    parts,
    attachments,
    text: texts.join("\n\n"),
    resolvedText: resolvedTexts.join("\n\n"),
    command: undefined,
  };
}

export function SessionSurface(props: SessionSurfaceProps) {
  const local = useLocal();
  const { config: shellConfig } = useShellConfig();
  const showThinking = local.prefs.showThinking;
  const sessionActivityStatus = useSessionActivityStore(
    (state) => state.statusesByWorkspaceId[props.workspaceId]?.[props.sessionId] ?? "idle",
  );
  const draft = useComposerStateStore((state) => getComposerDraft(state, props.sessionId));
  const attachments = useComposerStateStore((state) => getComposerAttachments(state, props.sessionId));
  const mentions = useComposerStateStore((state) => getComposerMentions(state, props.sessionId));
  const pasteParts = useComposerStateStore((state) => getComposerPasteParts(state, props.sessionId));
  const setComposerDraft = useComposerStateStore((state) => state.setDraft);
  const setComposerAttachments = useComposerStateStore((state) => state.setAttachments);
  const setComposerMentions = useComposerStateStore((state) => state.setMentions);
  const setComposerPasteParts = useComposerStateStore((state) => state.setPasteParts);
  const clearComposerSession = useComposerStateStore((state) => state.clearSession);
  const inputHistory = useComposerStateStore((state) => getComposerHistory(state, props.sessionId));
  const appendComposerHistory = useComposerStateStore((state) => state.appendHistory);
  // Queued follow-up drafts live in the shared composer store keyed by session
  // id. That keeps a queued message in session A from being drained into
  // session B when the route swaps the same surface component to another
  // session.
  const queuedDrafts = useComposerStateStore((state) => getComposerQueuedDrafts(state, props.sessionId));
  const officeAddinRuntime = isOfficeAddinRuntime();
  const fusionAvailable = !officeAddinRuntime;
  const storedFusionEnabled = useFusionStore((state) => Boolean(state.enabledSessionIds[props.sessionId]));
  const fusionEnabled = fusionAvailable && storedFusionEnabled;
  const fusionModels = useFusionStore((state) => state.selectedModelsBySessionId[props.sessionId]);
  const setFusionEnabled = useFusionStore((state) => state.setEnabled);
  const setFusionModels = useFusionStore((state) => state.setSelectedModels);
  const fusionDefaultModels = local.prefs.fusionModels;
  const [fusionIntroOpen, setFusionIntroOpen] = useState(false);
  useEffect(() => {
    if (!fusionAvailable && storedFusionEnabled) {
      setFusionEnabled(props.sessionId, false);
    }
  }, [fusionAvailable, props.sessionId, setFusionEnabled, storedFusionEnabled]);
  const handleToggleFusion = useCallback(() => {
    const store = useFusionStore.getState();
    const enabling = !store.enabledSessionIds[props.sessionId];
    // First enable on a chat seeds the candidate picker from the settings defaults.
    if (enabling && store.selectedModelsBySessionId[props.sessionId] === undefined) {
      setFusionModels(props.sessionId, fusionDefaultModels ?? []);
    }
    if (enabling && shouldShowFusionIntro()) {
      markFusionIntroSeen();
      setFusionIntroOpen(true);
    }
    setFusionEnabled(props.sessionId, enabling);
  }, [fusionDefaultModels, props.sessionId, setFusionEnabled, setFusionModels]);
  const handleFusionModelsChange = useCallback((models: ModelRef[]) => {
    setFusionModels(props.sessionId, models);
  }, [props.sessionId, setFusionModels]);
  const fusionConfigured = (fusionModels?.length ?? 0) > 0;
  const opencodeClient = useMemo(
    () => createClient(props.opencodeBaseUrl, undefined, { token: props.legalworkToken, mode: "legalwork" }),
    [props.opencodeBaseUrl, props.legalworkToken],
  );

  // Live-transcript sharing. `recording` is a stable object for the whole
  // capture (set at start, cleared at stop), so subscribing here doesn't
  // re-render the surface on every transcript segment.
  const desktopRecorderActive = useRecorderStore((state) =>
    Boolean(state.recording && state.recording.id !== state.dictationRecordingId),
  );
  const desktopLiveTranscriptActive = useRecorderStore(
    (state) => state.liveTranscriptSessionId === props.sessionId,
  );
  const officeRecorderQuery = useQuery({
    queryKey: ["office-recorder-live-transcript", props.workspaceId],
    queryFn: () => props.client.getRecorderLiveTranscript(props.workspaceId),
    enabled: officeAddinRuntime,
    refetchInterval: officeAddinRuntime ? 1_000 : false,
    retry: false,
  });
  const officeRecorderStatus = officeRecorderQuery.data;
  const refetchOfficeRecorder = officeRecorderQuery.refetch;
  const recorderActive = officeAddinRuntime
    ? Boolean(officeRecorderStatus?.available && officeRecorderStatus.recordingActive)
    : desktopRecorderActive;
  const liveTranscriptActive = officeAddinRuntime
    ? Boolean(officeRecorderStatus?.liveTranscriptActive)
    : desktopLiveTranscriptActive;
  const liveTranscriptToggleBusyRef = useRef(false);
  const handleToggleLiveTranscript = useCallback(async () => {
    if (liveTranscriptToggleBusyRef.current) return;
    liveTranscriptToggleBusyRef.current = true;
    try {
      if (officeAddinRuntime) {
        const result = await props.client.setRecorderLiveTranscript(
          props.workspaceId,
          !officeRecorderStatus?.liveTranscriptActive,
        );
        if (result.error) {
          toast.error(result.error);
          return;
        }
        if (result.liveTranscriptActive && result.fileName) {
          const body = t("recorder.live_share_notice").replace("{file}", result.fileName);
          try {
            unwrap(await opencodeClient.session.promptAsync({
              sessionID: props.sessionId,
              directory: props.workspaceRoot || undefined,
              noReply: true,
              parts: [{ type: "text", text: body, synthetic: true }],
            }));
          } catch {
            // The transcript is already live; a failed notice must not undo it.
          }
          toast.success(t("composer.live_transcript_started"));
        } else {
          toast.success(t("composer.live_transcript_stopped"));
        }
        return;
      }

      const store = useRecorderStore.getState();
      if (store.liveTranscriptSessionId === props.sessionId) {
        await store.stopLiveTranscriptShare();
        toast.success(t("composer.live_transcript_stopped"));
        return;
      }
      const started = await store.startLiveTranscriptShare(
        props.sessionId,
        props.workspaceRoot || "",
        props.workspaceRoot || undefined,
      );
      if (started) toast.success(t("composer.live_transcript_started"));
    } catch (toggleError) {
      toast.error(toggleError instanceof Error ? toggleError.message : t("app.unknown_error"));
    } finally {
      liveTranscriptToggleBusyRef.current = false;
      if (officeAddinRuntime) await refetchOfficeRecorder();
    }
  }, [
    officeAddinRuntime,
    officeRecorderStatus?.liveTranscriptActive,
    opencodeClient,
    props.client,
    props.sessionId,
    props.workspaceId,
    props.workspaceRoot,
    refetchOfficeRecorder,
  ]);
  const appendQueuedDraft = useComposerStateStore((state) => state.appendQueuedDraft);
  const removeQueuedDraftFromStore = useComposerStateStore((state) => state.removeQueuedDraft);
  const clearQueuedDrafts = useComposerStateStore((state) => state.clearQueuedDrafts);
  const prependQueuedDrafts = useComposerStateStore((state) => state.prependQueuedDrafts);
  const [error, setError] = useState<SessionError | null>(null);
  const [sending, setSending] = useState(false);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
  const [awaitingAssistantBaseline, setAwaitingAssistantBaseline] = useState<number | null>(null);
  const [rendered, setRendered] = useState<{ sessionId: string; snapshot: LegalworkSessionSnapshot } | null>(null);
  const [toolSkills, setToolSkills] = useState<SkillCard[]>([]);
  const [toolMcpServers, setToolMcpServers] = useState<McpServerEntry[]>([]);
  const [toolMcpStatus, setToolMcpStatus] = useState<string | null>(null);
  const [toolMcpStatuses, setToolMcpStatuses] = useState<McpStatusMap>({});
  const [toolImportedPlugins, setToolImportedPlugins] = useState<ImportedPlugin[]>([]);
  const [verifiedOpenTargets, setVerifiedOpenTargets] = useState<OpenTarget[]>([]);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const autoOpenedTargetRef = useRef<string | null>(null);
  const initializedAutoOpenSessionRef = useRef<string | null>(null);
  // One daily-limit stop per failing run (re-armed by session switch, a new
  // busy attempt, or a failed abort).
  const budgetStopFiredRef = useRef(false);
  const snapshotQueryKey = useMemo(
    () => reactSnapshotKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const transcriptQueryKey = useMemo(
    () => reactTranscriptKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const statusQueryKey = useMemo(
    () => reactStatusKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const snapshotQuery = useQuery<LegalworkSessionSnapshot>({
    queryKey: snapshotQueryKey,
    queryFn: async () => (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, { limit: 140 })).item,
    staleTime: 500,
  });

  const currentSnapshot = snapshotQuery.data?.session.id === props.sessionId ? snapshotQuery.data : null;
  const transcriptState = useSharedQueryState<UIMessage[]>(transcriptQueryKey, EMPTY_TRANSCRIPT);
  const statusState = useSharedQueryState(statusQueryKey, currentSnapshot?.status ?? IDLE_STATUS);

  useEffect(() => {
    if (!currentSnapshot) return;
    setRendered({ sessionId: props.sessionId, snapshot: currentSnapshot });
  }, [props.sessionId, currentSnapshot]);

  useEffect(() => {
    hydratedKeyRef.current = null;
    setError(null);
    setSending(false);
    setShowDelayedLoading(false);
    setAwaitingAssistantBaseline(null);
    // Composer draft state lives in the shared store keyed by session id, so
    // switching sessions preserves each session's own in-progress composer.
    autoOpenedTargetRef.current = null;
    initializedAutoOpenSessionRef.current = null;
    budgetStopFiredRef.current = false;
    setVerifiedOpenTargets([]);
  }, [props.sessionId]);

  // Publish a composer inspector slice so external drivers can read draft
  // state, attachments, mentions, and sending status from the running app.
  useEffect(() => {
    const dispose = publishInspectorSlice("composer", () => ({
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      draft,
      draftLength: draft.length,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
      })),
      mentions,
      pasteParts: pasteParts.map((part) => ({
        id: part.id,
        label: part.label,
        lines: part.lines,
      })),
      sending,
      error,
    }));
    return dispose;
  }, [
    attachments,
    draft,
    error,
    mentions,
    pasteParts,
    props.sessionId,
    props.workspaceId,
    sending,
  ]);

  useEffect(() => {
    recordInspectorEvent("session.mounted", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
    });
  }, [props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [currentSnapshot, props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    const key = `${props.sessionId}:${currentSnapshot.session.time?.updated ?? currentSnapshot.session.time?.created ?? 0}:${currentSnapshot.messages.length}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [props.sessionId, currentSnapshot, props.workspaceId]);

  const snapshot = resolveRenderedSessionSnapshot({
    sessionId: props.sessionId,
    currentSnapshot,
    cachedRendered: rendered,
  });
  const liveStatus = statusState ?? snapshot?.status ?? IDLE_STATUS;
  const chatStreaming = sending || liveStatus.type === "busy" || liveStatus.type === "retry";
  const status = useMemo((): ThreadStatus => {
    if (sending) {
      return "submitted";
    }

    if (liveStatus.type === "busy") {
      return "streaming";
    }

    if (liveStatus.type === "retry") {
      return "retrying";
    }

    return "ready";
  }, [liveStatus, sending]);

  // --- Eigenwelt free-tier daily-limit retries -----------------------------
  // Gateway budget errors (LiteLLM 429 "Budget has been exceeded" on the
  // free key's daily budget) never resolve on their own, so the engine's
  // endless retry/backoff loop is pointless. Policy: let it retry up to 3
  // attempts (with an upgrade action on the banner), then abort the run and
  // surface the friendly terminal limit card. Gated on the session's selected
  // provider being `eigenwelt-free`; every other provider/error keeps the
  // engine's default retry behavior.
  const budgetRetryActive =
    liveStatus.type === "retry" &&
    isEigenweltFreeBudgetError(props.selectedModel.providerID, liveStatus.message);
  const retryStatusForDisplay = useMemo(() => {
    if (liveStatus.type !== "retry") return null;
    if (!budgetRetryActive || liveStatus.action) return liveStatus;
    return { ...liveStatus, action: eigenweltFreeBudgetRetryAction() };
  }, [budgetRetryActive, liveStatus]);
  useEffect(() => {
    // A fresh attempt (busy) re-arms the guard so a later prompt that hits
    // the daily limit again is stopped again.
    if (liveStatus.type === "busy") budgetStopFiredRef.current = false;
  }, [liveStatus.type]);
  useEffect(() => {
    if (liveStatus.type !== "retry") return;
    if (!shouldStopEigenweltFreeBudgetRetry(props.selectedModel.providerID, liveStatus.message, liveStatus.attempt)) return;
    if (budgetStopFiredRef.current) return;
    budgetStopFiredRef.current = true;
    const attempt = liveStatus.attempt;
    // Stop means stop (mirrors handleAbort): drop queued follow-ups so the
    // queue-drain effect doesn't re-prompt straight into the same limit wall.
    clearQueuedDrafts(props.sessionId);
    // Render the terminal card immediately; the engine's abort error for the
    // same turn reconciles into this message (see session-sync's
    // budget-stop substitution).
    injectSessionErrorMessage(props.workspaceId, props.sessionId, EIGENWELT_FREE_LIMIT_ERROR_TEXT);
    markEigenweltFreeBudgetStop(props.sessionId);
    void (async () => {
      const aborted = await abortSessionSafe(
        opencodeClient,
        props.sessionId,
        props.workspaceRoot.trim() || undefined,
      );
      if (!aborted) {
        // Engine unreachable or scope mismatch — re-arm so the next retry
        // event tries the abort again instead of backing off forever.
        budgetStopFiredRef.current = false;
        return;
      }
      captureAnalyticsEvent("task_run_free_limit_stopped", { attempts: attempt });
      await snapshotQuery.refetch();
    })();
  }, [clearQueuedDrafts, liveStatus, opencodeClient, props.selectedModel.providerID, props.sessionId, props.workspaceId, props.workspaceRoot, snapshotQuery.refetch]);
  const renderedMessages = useMemo(
    () => deriveRenderedSessionMessages({ transcriptState, snapshot }),
    [snapshot, transcriptState],
  );
  const openTargets = useMemo(() => deriveOpenTargets(renderedMessages), [renderedMessages]);
  const openTargetsFingerprint = useMemo(
    () => openTargets.map((target) => `${target.kind}:${target.value}:${target.confidence}`).join("|"),
    [openTargets],
  );
  const autoOpenTarget = selectAutoOpenTarget(verifiedOpenTargets);
  const pendingSessionLoad = !snapshot && snapshotQuery.isLoading && renderedMessages.length === 0;
  const assistantOutputAfterAwaitStart = useMemo(() => {
    if (awaitingAssistantBaseline === null) return false;
    return renderedMessages
      .slice(awaitingAssistantBaseline)
      .some(messageHasVisibleAssistantOutput);
  }, [awaitingAssistantBaseline, renderedMessages]);
  const showAssistantWaitState = awaitingAssistantBaseline !== null && !assistantOutputAfterAwaitStart;
  const showAssistantRespondingState = awaitingAssistantBaseline !== null && assistantOutputAfterAwaitStart && chatStreaming;
  const effectiveActivityStatus: SessionActivityStatus = sessionActivityStatus !== "idle"
    ? sessionActivityStatus
    : showAssistantWaitState
      ? "thinking"
      : showAssistantRespondingState
        ? "responding"
        : "idle";
  useReactRenderWatchdog("SessionSurface", {
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    messageCount: renderedMessages.length,
    liveStatus: liveStatus.type,
    sending,
    pendingSessionLoad,
    showAssistantWaitState,
    showAssistantRespondingState,
    hasSnapshot: Boolean(snapshot),
  });

  useEffect(() => {
    if (!autoOpenTarget || chatStreaming) return;
    if (autoOpenedTargetRef.current === autoOpenTarget.id) return;
    autoOpenedTargetRef.current = autoOpenTarget.id;
    props.onOpenTarget?.(autoOpenTarget, { auto: true }, props.sessionId);
  }, [autoOpenTarget, chatStreaming, props.onOpenTarget, props.sessionId]);

  useEffect(() => {
    let cancelled = false;
    function initializeAutoOpenState(targets: OpenTarget[]) {
      if (initializedAutoOpenSessionRef.current === props.sessionId) return;
      initializedAutoOpenSessionRef.current = props.sessionId;
      autoOpenedTargetRef.current = selectAutoOpenTarget(targets)?.id ?? null;
    }

    async function verifyTargets() {
      if (!openTargets.length) {
        initializeAutoOpenState([]);
        setVerifiedOpenTargets([]);
        return;
      }
      try {
        const response = await props.client.resolveArtifacts(props.workspaceId, openTargets);
        if (!cancelled) {
          const nextTargets = response.items as OpenTarget[];
          initializeAutoOpenState(nextTargets);
          setVerifiedOpenTargets(nextTargets);
        }
      } catch {
        if (!cancelled) {
          const nextTargets = openTargets.map((target) => ({ ...target, exists: target.kind === "url" }));
          initializeAutoOpenState(nextTargets);
          setVerifiedOpenTargets(nextTargets);
        }
      }
    }
    void verifyTargets();
    return () => { cancelled = true; };
  }, [openTargetsFingerprint, props.client, props.sessionId, props.workspaceId]);

  useEffect(() => {
    usePanelTabStore.getState().syncTranscriptArtifacts(props.sessionId, verifiedOpenTargets);
  }, [props.sessionId, verifiedOpenTargets]);

  useEffect(() => {
    if (!pendingSessionLoad) {
      setShowDelayedLoading(false);
      return;
    }
    const id = window.setTimeout(() => setShowDelayedLoading(true), 2000);
    return () => window.clearTimeout(id);
  }, [pendingSessionLoad]);

  useEffect(() => {
    if (awaitingAssistantBaseline === null) return;
    if (assistantOutputAfterAwaitStart) {
      return;
    }
    if (sending || liveStatus.type !== "idle" || renderedMessages.length <= awaitingAssistantBaseline) return;
    const id = window.setTimeout(() => {
      setAwaitingAssistantBaseline(null);
    }, 1200);
    return () => window.clearTimeout(id);
  }, [assistantOutputAfterAwaitStart, awaitingAssistantBaseline, liveStatus.type, renderedMessages.length, sending]);

  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId: renderedMessages.length > 0 || snapshot ? props.sessionId : null,
    hasSnapshot: Boolean(snapshot) || renderedMessages.length > 0,
    isFetching: snapshotQuery.isFetching,
    isError: snapshotQuery.isError || Boolean(error),
  });

  const buildDraft = useCallback((text: string, nextAttachments: ComposerAttachment[]): ComposerDraft => {
    const parts: ComposerPart[] = text.split(/(\[pasted text [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/).flatMap((segment) => {
      if (!segment) return [] as ComposerDraft["parts"];
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch) {
        const target = pasteParts.find((item) => item.label === pasteMatch[1]);
        if (target) {
          return [{ type: "paste", id: target.id, label: target.label, text: target.text, lines: target.lines }];
        }
      }
      const skillMatch = segment.match(/^\[skill (.+)\]$/);
      if (skillMatch?.[1]) {
        return [{ type: "skill", name: skillMatch[1] } satisfies ComposerDraft["parts"][number]];
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const kind = mentions[value];
        if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "app") return [{ type: "app", name: value } satisfies ComposerDraft["parts"][number]];
      }
      return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
    });
    // Expand paste placeholders in resolvedText so the model receives
    // the actual pasted content instead of "[pasted text <label>]".
    let resolved = text;
    for (const part of pasteParts) {
      resolved = resolved.replace(`[pasted text ${part.label}]`, part.text);
    }
    resolved = resolved.replace(/\[skill ([^\]]+)\]/g, (_match, name: string) => `the \"${name}\" skill`);
    for (const value of Object.keys(mentions)) {
      resolved = resolved.replaceAll(`@${encodeComposerMentionValue(value)}`, `@${value}`);
    }
    const slashCommand = parseSlashCommandInvocation(resolved);
    return {
      mode: "prompt",
      parts,
      attachments: nextAttachments,
      text,
      resolvedText: resolved,
      command: slashCommand ?? undefined,
    };
  }, [mentions, pasteParts]);

  const handleComposerDraftChange = useCallback((value: string) => {
    setComposerDraft(props.sessionId, value);
  }, [props.sessionId, setComposerDraft]);

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(renderedMessages));
    } catch (nextError) {
      setError({ message: nextError instanceof Error ? nextError.message : "Failed to copy transcript." });
    }
  };

  // Core sender shared by initial send and steered follow-ups. OpenCode
  // accepts follow-up user turns mid-run (steering) — the running loop picks
  // up the new message — so this is safe to call while the agent is busy.
  const sendDraft = useCallback(async (nextDraft: ComposerDraft, draftAttachments: ComposerAttachment[]) => {
    setError(null);
    // Record the prompt for Up/Down recall in the composer (#2012).
    appendComposerHistory(props.sessionId, nextDraft.text);
    useSessionActivityStore.getState().setRunStatus(props.workspaceId, props.sessionId, { type: "busy" });
    setSending(true);
    setAwaitingAssistantBaseline(renderedMessages.length);
    try {
      await props.onSendDraft(nextDraft, props.sessionId);
      draftAttachments.forEach(revokeAttachmentPreview);
      setSending(false);
    } catch (nextError) {
      const parsed = parseSessionError(nextError);
      captureAnalyticsEvent("task_send_failed", {
        session_id: props.sessionId,
        service: analyticsErrorService(nextError),
        status_code: analyticsErrorStatus(nextError),
        surface: analyticsSurface(),
      });
      setError(parsed);
      useSessionActivityStore.getState().setError(props.workspaceId, props.sessionId, parsed.message);
      setComposerDraft(props.sessionId, "");
      setAwaitingAssistantBaseline(null);
      setSending(false);
      throw nextError;
    }
  }, [appendComposerHistory, props.onSendDraft, props.sessionId, props.workspaceId, renderedMessages.length, setComposerDraft]);

  const clearComposer = useCallback(() => {
    clearComposerSession(props.sessionId);
    props.onDraftChange(buildDraft("", []));
  }, [buildDraft, clearComposerSession, props.onDraftChange, props.sessionId]);

  // Initial send (agent idle) and explicit "Steer" follow-up (agent busy)
  // share the same immediate path.
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    const nextDraft = buildDraft(text, attachments);
    const sentAttachments = attachments;
    try {
      await sendDraft(nextDraft, sentAttachments);
      clearComposer();
    } catch {
      setComposerDraft(props.sessionId, "");
    }
  }, [attachments, buildDraft, clearComposer, draft, props.sessionId, sendDraft, setComposerDraft]);

  const handleSteer = handleSend;

  // Queue: hold the draft locally and clear the composer. The drain effect
  // sends it once the session reports idle.
  const handleQueue = useCallback(() => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    appendQueuedDraft(props.sessionId, buildDraft(text, attachments));
    clearComposer();
  }, [appendQueuedDraft, attachments, buildDraft, clearComposer, draft, props.sessionId]);

  const removeQueuedDraft = useCallback((index: number) => {
    removeQueuedDraftFromStore(props.sessionId, index);
  }, [props.sessionId, removeQueuedDraftFromStore]);

  // One label per queued draft, kept index-aligned with `queuedDrafts` so the
  // panel's remove action targets the correct entry. Attachment-only drafts
  // (no text) fall back to a count label instead of being dropped.
  const queuedMessages = useMemo(
    () =>
      queuedDrafts.map((draftItem) => {
        const text = draftItem.text.trim();
        if (text) return text;
        return t("composer.queued_attachments_only", { count: draftItem.attachments.length });
      }),
    [queuedDrafts],
  );

  const handleAbort = useCallback(async () => {
    if (!chatStreaming) return;
    setError(null);
    // Stop means stop: drop queued follow-ups before aborting, otherwise the
    // queue-drain effect below re-prompts the agent the moment the abort
    // lands and the session reports idle (#2014).
    clearQueuedDrafts(props.sessionId);
    // The prompt was sent through a directory-scoped client (session-route
    // passes the workspace root), so the abort must target the same scope —
    // without it the server resolves the default project, finds no live run,
    // and answers `200: false` while the stream keeps going (#2014).
    const aborted = await abortSessionSafe(
      opencodeClient,
      props.sessionId,
      props.workspaceRoot.trim() || undefined,
    );
    if (!aborted) {
      setError({ message: t("session.stop_failed") });
      return;
    }
    captureAnalyticsEvent("task_run_stopped", {
      session_id: props.sessionId,
      surface: analyticsSurface(),
    });
    await snapshotQuery.refetch();
  }, [chatStreaming, clearQueuedDrafts, opencodeClient, props.sessionId, props.workspaceRoot, snapshotQuery.refetch]);

  const handleDismissError = useCallback(() => {
    setError(null);
    useSessionActivityStore.getState().clearError(props.workspaceId, props.sessionId);
  }, [props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (liveStatus.type === "idle") {
      setSending(false);
    }
  }, [liveStatus.type]);

  // Drain the queued follow-ups once the session goes idle. OpenCode has no
  // server-side queue, so we send everything that's queued as a single merged
  // message. The ref guards against re-entrancy while the send is in flight.
  const drainingQueueRef = useRef(false);
  useEffect(() => {
    if (drainingQueueRef.current) return;
    if (queuedDrafts.length === 0) return;
    if (chatStreaming || liveStatus.type !== "idle") return;
    const merged = mergeDrafts(queuedDrafts);
    if (!merged) return;
    const drained = queuedDrafts;
    drainingQueueRef.current = true;
    clearQueuedDrafts(props.sessionId);
    void (async () => {
      try {
        await sendDraft(merged, merged.attachments);
      } catch {
        // Restore the queue so the user can retry / edit on failure.
        prependQueuedDrafts(props.sessionId, drained);
      } finally {
        drainingQueueRef.current = false;
      }
    })();
  }, [chatStreaming, clearQueuedDrafts, liveStatus.type, prependQueuedDrafts, props.sessionId, queuedDrafts, sendDraft]);

  useEffect(() => {
    props.onDraftChange(buildDraft(draft, attachments));
  }, [attachments, buildDraft, draft, props.onDraftChange]);

  const handleAttachFiles = (files: File[]) => {
    if (!props.attachmentsEnabled) {
      toast.warning(props.attachmentsDisabledReason ?? "Attachments are unavailable.");
      return;
    }
    const oversized = files.filter((file) => file.size > 25 * 1024 * 1024);
    const sized = files.filter((file) => file.size <= 25 * 1024 * 1024);
    if (oversized.length) {
      toast.warning(
        oversized.length === 1 ? `${oversized[0]?.name ?? "File"} is too large` : `${oversized.length} files are too large`,
        { description: "Files over 25 MB were skipped." },
      );
    }
    const unreadable = sized.filter((file) => !isModelReadableAttachment(file.type));
    const accepted = sized.filter((file) => isModelReadableAttachment(file.type));
    if (unreadable.length) {
      toast.warning(
        unreadable.length === 1
          ? `${unreadable[0]?.name ?? "File"} has a format the model can't read`
          : `${unreadable.length} files have formats the model can't read`,
        { description: "Convert to PDF, image, or plain text and attach again." },
      );
    }
    if (!accepted.length) return;
    const next = accepted.map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      kind: file.type.startsWith("image/") ? "image" as const : "file" as const,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setComposerAttachments(props.sessionId, [...attachments, ...next]);
  };

  const handleRemoveAttachment = (id: string) => {
    const target = attachments.find((item) => item.id === id);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
    }
    setComposerAttachments(props.sessionId, attachments.filter((item) => item.id !== id));
  };

  const handleInsertMention = (kind: ComposerMentionKind, value: string) => {
    // @agent mentions switch the session agent instead of inserting an agent
    // part. Agent parts are treated as *subagent* (task tool) calls by the
    // engine, which silently fails for primary agents and left every reply
    // coming from the default agent (#2101).
    if (kind === "agent") {
      setComposerDraft(props.sessionId, draft.replace(/@([^\s@]*)$/, ""));
      props.onSelectAgent(value);
      toast.success(t("composer.agent_selected", { agent: value }));
      return;
    }
    setComposerDraft(props.sessionId, draft.replace(/@([^\s@]*)$/, `@${encodeComposerMentionValue(value)} `));
    setComposerMentions(props.sessionId, { ...mentions, [value]: kind });
    // Pre-flight Computer Use permissions when an app is mentioned so missing
    // Accessibility / Screen Recording grants surface before send, not as a
    // mid-task failure. Only ever runs on macOS desktop (apps aren't offered
    // elsewhere); errors are silently ignored.
    if (kind === "app") {
      void (async () => {
        try {
          const status = (await desktopBridge.checkComputerUsePermissions()) as { ok?: boolean };
          if (status.ok === true) return;
          toast.warning(t("composer.computer_use_permissions_missing", { app: value }), {
            action: {
              label: t("composer.computer_use_permissions_setup"),
              onClick: () => void desktopBridge.openComputerUsePermissionSetup(),
            },
          });
        } catch {
          // Desktop bridge unavailable — nothing to pre-flight.
        }
      })();
    }
  };

  const handlePasteText = (text: string) => {
    const id = `paste-${Math.random().toString(36).slice(2)}`;
    const label = `${id.slice(-4)} · ${text.split(/\r?\n/).length} lines`;
    setComposerPasteParts(props.sessionId, [...pasteParts, { id, label, text, lines: text.split(/\r?\n/).length }]);
    setComposerDraft(props.sessionId, `${draft}[pasted text ${label}]`);
  };

  const handleExpandPastedText = (id: string) => {
    const part = pasteParts.find((item) => item.id === id);
    if (!part) return;
    setComposerDraft(props.sessionId, draft.replace(`[pasted text ${part.label}]`, part.text));
    setComposerPasteParts(props.sessionId, pasteParts.filter((item) => item.id !== id));
  };

  const handleRemovePastedText = (id: string) => {
    const target = pasteParts.find((item) => item.id === id);
    if (!target) return;
    setComposerDraft(props.sessionId, draft.replace(`[pasted text ${target.label}]`, ""));
    setComposerPasteParts(props.sessionId, pasteParts.filter((item) => item.id !== id));
  };

  const handleUnsupportedFileLinks = (links: string[]) => {
    if (!links.length) return;
    setComposerDraft(props.sessionId, `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  };

  const typeComposerText = useCallback(async (text: string) => {
    window.dispatchEvent(new Event("legalwork:focusPrompt"));
    setComposerDraft(props.sessionId, text);
    await waitForControl(40);
  }, [props.sessionId, setComposerDraft]);

  useEffect(() => {
    const handleVoiceTranscript = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== "object" || Array.isArray(detail) || !("text" in detail) || typeof detail.text !== "string") return;
      const text = detail.text;
      void typeComposerText(text);
      props.onDraftChange(buildDraft(text, attachments));
      recordInspectorEvent("voice.transcript.applied", {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        length: text.length,
      });
    };
    window.addEventListener("legalwork:voice-transcript", handleVoiceTranscript);
    return () => window.removeEventListener("legalwork:voice-transcript", handleVoiceTranscript);
  }, [attachments, buildDraft, props.onDraftChange, props.sessionId, props.workspaceId, typeComposerText]);

  const composerSetTextControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "composer.set_text",
    label: "Type into the composer",
    description: "Replace the current session draft and type the supplied text visibly.",
    sideEffect: "none",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true, description: "Prompt text to place in the composer." }],
    previewArgs: { text: DEFAULT_COMPOSER_CONTROL_TEXT },
    targetRef: composerShellRef,
    execute: async (args, helpers) => {
      const text = controlTextArgument(args);
      helpers.setNarration(`Typing ${text.length.toLocaleString()} characters into the composer…`);
      await typeComposerText(text);
      props.onDraftChange(buildDraft(text, attachments));
      return { draftLength: text.length };
    },
  }), [attachments, buildDraft, props.onDraftChange, typeComposerText]);
  useControlAction(composerSetTextControlAction);

  const composerSendControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "composer.send",
    label: "Send the composer prompt",
    description: "Send the currently visible composer draft to the active session.",
    sideEffect: "mutation",
    disabled: props.modelUnavailable || (!draft.trim() && attachments.length === 0) || model.transitionState !== "idle",
    targetRef: composerShellRef,
    execute: async () => {
      await handleSend();
      return true;
    },
  }), [attachments.length, draft, handleSend, model.transitionState, props.modelUnavailable]);
  useControlAction(composerSendControlAction);

  const composerStopControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "composer.stop",
    label: "Stop the current run",
    description: "Stop the current streaming session run.",
    sideEffect: "mutation",
    disabled: !chatStreaming,
    targetRef: composerShellRef,
    execute: async () => {
      await handleAbort();
      return true;
    },
  }), [chatStreaming, handleAbort]);
  useControlAction(composerStopControlAction);

  const listSkills = async (): Promise<SkillCard[]> => {
    const response = await props.client.listSkills(props.workspaceId, { includeGlobal: true });
    const next = (response.items ?? []).map((skill) => ({
      name: skill.name,
      path: skill.path,
      description: skill.description,
      trigger: skill.trigger,
    } satisfies SkillCard));
    setToolSkills(next);
    return next;
  };

  const listMcp = async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
    const response = await props.client.listMcp(props.workspaceId);
    const servers = (response.items ?? []).map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
    } satisfies McpServerEntry));

    let statuses: McpStatusMap = {};
    try {
      if (props.workspaceRoot.trim()) {
        statuses = unwrap(await opencodeClient.mcp.status({ directory: props.workspaceRoot.trim() })) as McpStatusMap;
      }
    } catch {
      statuses = {};
    }

    const status = servers.length ? null : "No MCP servers loaded.";
    setToolMcpServers(servers);
    setToolMcpStatuses(statuses);
    setToolMcpStatus(status);
    return { servers, statuses, status };
  };

  const listImportedPlugins = async (): Promise<ImportedPlugin[]> => {
    const response = await props.client.getConfig(props.workspaceId);
    const plugins = Object.values(readWorkspaceImports(response.legalwork).plugins)
      .sort((left, right) => left.name.localeCompare(right.name));
    setToolImportedPlugins(plugins);
    return plugins;
  };

  const handleUploadInboxFiles = async (files: File[]) => {
    const input = files.filter(Boolean);
    if (!input.length) return;
    try {
      const results = await Promise.all(input.map((file) => props.client.uploadInbox(props.workspaceId, file)));
      return results;
    } catch (nextError) {
      toast.warning(nextError instanceof Error ? nextError.message : "Shared folder upload failed");
      throw nextError;
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionScroll = useSessionScrollController({
    selectedSessionId: props.sessionId,
    renderedMessages,
    containerRef: scrollRef,
    contentRef,
  });

  // Sending a message is an explicit "take me to the latest": jump to the
  // bottom and re-arm follow mode regardless of any prior manual scrolling
  // (awaitingAssistantBaseline is set exactly once per send).
  const scrollToBottomOnSend = sessionScroll.scrollToBottom;
  useEffect(() => {
    if (awaitingAssistantBaseline !== null) scrollToBottomOnSend("auto");
  }, [awaitingAssistantBaseline, scrollToBottomOnSend]);

  const handleMessageListDispatchAction = useCallback((action: DispatchAction) => {
    if (action.target === "settings" && action.action === "open") {
      props.onOpenSettingsSection?.(action.section);
    }
  }, [props.onOpenSettingsSection]);

  const handleMessageListSetPrompt = useCallback((prompt: string) => {
    void typeComposerText(prompt);
  }, [typeComposerText]);

  const handleRevertToUserMessage = useCallback((messageId: string) => {
    void props.onRevertToMessage?.(messageId, props.sessionId);
  }, [props.onRevertToMessage, props.sessionId]);

  const handleForkAtMessage = useCallback((messageId: string) => {
    // OpenCode's fork copies messages strictly before the given id, so pass
    // the next real message to make the branch include the clicked message.
    props.onForkAtMessage?.(resolveForkBoundaryId(renderedMessages, messageId), props.sessionId);
  }, [props.onForkAtMessage, props.sessionId, renderedMessages]);

  const handleEditUserMessage = useCallback((messageId: string, text: string) => {
    void (async () => {
      // Rewind the session to just before this prompt, then restore the
      // prompt text into the composer so the user can rewrite and resend it.
      const reverted = await props.onRevertToMessage?.(messageId, props.sessionId);
      if (reverted === false) return;
      await typeComposerText(text);
    })();
  }, [props.onRevertToMessage, props.sessionId, typeComposerText]);

  const sessionScrollTopControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "session.scroll_top",
    label: "Go to the top of the session",
    description: "Scroll the visible session transcript to the first messages.",
    sideEffect: "none",
    execute: () => {
      const container = scrollRef.current;
      if (!container) return { ok: false, error: "Session transcript is not mounted" };
      container.scrollTo({ top: 0, behavior: "smooth" });
      return { ok: true, position: "top" };
    },
  }), []);
  useControlAction(sessionScrollTopControlAction);

  const sessionScrollBottomControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "session.scroll_bottom",
    label: "Go to the bottom of the session",
    description: "Scroll the visible session transcript to the newest messages and composer area.",
    sideEffect: "none",
    execute: () => {
      sessionScroll.jumpToLatest("smooth");
      return { ok: true, position: "bottom" };
    },
  }), [sessionScroll.jumpToLatest]);
  useControlAction(sessionScrollBottomControlAction);

  const sessionLatestMessageControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "session.latest_message",
    label: "Read the latest session message",
    description: "Return the latest visible message in the current session transcript.",
    sideEffect: "none",
    execute: () => {
      const message = renderedMessages[renderedMessages.length - 1];
      if (!message) return { ok: false, error: "No messages are visible in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        index: renderedMessages.length - 1,
        role: message.role,
        text: messageToReadableText(message),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(sessionLatestMessageControlAction);

  const sessionReadTranscriptControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "session.read_transcript",
    label: "Read the current session transcript",
    description: "Return the last messages from the current session transcript as readable text, including the session ID, title, and message count.",
    sideEffect: "none",
    args: [{ name: "count", type: "number", required: false, description: "Number of recent messages to return, from 1 to 30. Defaults to 10." }],
    execute: (args) => {
      const count = typeof args === "object" && args !== null && "count" in args && typeof (args as { count?: unknown }).count === "number"
        ? Math.min(Math.max(1, (args as { count: number }).count), 30)
        : 10;
      const total = renderedMessages.length;
      const slice = renderedMessages.slice(-count);
      if (!slice.length) return { ok: false, error: "No messages in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        messageCount: total,
        returned: slice.length,
        messages: slice.map((message, index) => ({
          index: total - slice.length + index,
          role: message.role,
          text: messageToReadableText(message),
        })),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(sessionReadTranscriptControlAction);

  return (
    <DevProfiler id="SessionSurface">
    <div className="flex h-full min-h-0 flex-col">
      {fusionAvailable ? <FusionIntroDialog open={fusionIntroOpen} onOpenChange={setFusionIntroOpen} /> : null}
      {model.transitionState === "switching" && showDelayedLoading ? (
        <div className="flex justify-center px-6 pt-4">
          <div className="rounded-full border border-dls-border bg-dls-hover/80 px-3 py-1 text-xs text-dls-secondary">
            {model.renderSource === "cache" ? "Switching session from cache..." : "Switching session..."}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onWheel={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchStart={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchMove={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            sessionScroll.markScrollGesture(event.currentTarget);
          }}
          onScroll={sessionScroll.handleScroll}
          className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-4 sm:px-5"
        >
          {/* Chat column: tighter than the composer (800px) so messages
               keep a comfortable reading width and don't feel "too big". */}
          <div ref={contentRef} className="mx-auto w-full max-w-[720px]">
            {showDelayedLoading && pendingSessionLoad ? (
              <div className="px-6 py-16">
                <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
                  <div className="text-sm text-dls-secondary">Opening session…</div>
                </div>
              </div>
            ) : (snapshotQuery.isError || error) && !snapshot && renderedMessages.length === 0 ? (
              <div className="px-6 py-8">
                {error ? (
                  <SessionErrorCard
                    error={error}
                    onDismiss={handleDismissError}
                    onChangeModel={props.onChangeModel}
                    onOpenModelPicker={props.onModelClick}
                  />
                ) : (
                  <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
                    {snapshotQuery.error instanceof Error ? snapshotQuery.error.message : "Failed to load session."}
                  </div>
                )}
              </div>
            ) : renderedMessages.length === 0 && effectiveActivityStatus !== "idle" ? (
              <div className="px-6 py-12">
                <AssistantWaitingCard label={getSessionActivityStatusLabel(effectiveActivityStatus)} />
              </div>
            ) : renderedMessages.length === 0 && snapshot && snapshot.messages.length === 0 && error ? (
              <SessionErrorCard
                error={error}
                onDismiss={handleDismissError}
                onChangeModel={props.onChangeModel}
                onOpenModelPicker={props.onModelClick}
              />
            ) : (
              <DevProfiler id="MessageList">
                <OpenTargetProvider
                  openTargets={verifiedOpenTargets}
                  onOpenTarget={props.onOpenTarget}
                >
                  <EnvironmentVariableProvider
                    client={props.isRemoteWorkspace ? null : props.environmentClient ?? props.client}
                    runtimeKey={props.environmentRuntimeKey}
                    onApplyChanges={props.onApplyEnvironmentChanges}
                  >
                    <MessageListProvider
                      workspaceId={props.workspaceId}
                      sessionId={props.sessionId}
                      showThinking={showThinking}
                      developerMode={props.developerMode}
                      displaySuggestions={shellConfig.starterCards}
                      providerConnectedCount={props.providerConnectedCount ?? 0}
                      dispatchAction={handleMessageListDispatchAction}
                      setPrompt={handleMessageListSetPrompt}
                      onRevertToUserMessage={handleRevertToUserMessage}
                      onForkAtMessage={handleForkAtMessage}
                      onEditUserMessage={handleEditUserMessage}
                    >
                      <MessageList
                        messages={renderedMessages}
                        status={status}
                        retryStatus={retryStatusForDisplay}
                      />
                    </MessageListProvider>
                  </EnvironmentVariableProvider>
                </OpenTargetProvider>
              </DevProfiler>
            )}
          </div>
        </div>
        <SessionScrollOverlay
          sessionId={props.sessionId}
          isStreaming={chatStreaming}
          onJumpToLatest={sessionScroll.jumpToLatest}
          onJumpToStartOfMessage={sessionScroll.jumpToStartOfMessage}
        />
      </div>

      <div ref={composerShellRef} className="shrink-0 px-0 pb-2 pt-2">
        {(props.providerConnectedCount ?? 0) === 0 ? (
          <button
            type="button"
            className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-amber-7/40 bg-amber-2/30 px-3 py-2 text-left text-xs text-amber-11 transition-colors hover:bg-amber-3/40"
            onClick={() => props.onOpenSettingsSection?.("providers")}
          >
            <span className="font-medium">No AI model connected.</span>
            <span className="text-amber-11/70">Add a provider to run tasks.</span>
          </button>
        ) : null}
        {fusionEnabled && !fusionConfigured ? (
          <div className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-lg border border-amber-7/40 bg-amber-2/30 px-3 py-2 text-xs text-amber-11">
            <span className="font-medium">{t("fusion.banner_not_configured")}</span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded-full border border-amber-7/50 px-2.5 py-1 font-medium transition-colors hover:bg-amber-3/50"
              onClick={() => props.onOpenSettingsSection?.("providers")}
            >
              {t("fusion.banner_open_settings")}
            </button>
          </div>
        ) : null}
        <DevProfiler id="SessionComposer">
        <ReactSessionComposer
          draft={draft}
          mentions={mentions}
          onDraftChange={handleComposerDraftChange}
        onSend={handleSend}
        onSteer={handleSteer}
        onQueue={handleQueue}
        onStop={handleAbort}
        busy={chatStreaming}
        queuedCount={queuedMessages.length}
        disabled={model.transitionState !== "idle" || Boolean(props.modelUnavailable)}
        modelUnavailable={Boolean(props.modelUnavailable)}
        statusLabel={statusLabel(snapshot ?? undefined, chatStreaming)}
        modelPickerOpen={props.modelPickerOpen}
        selectedModel={props.selectedModel}
        onModelPickerOpenChange={props.onModelPickerOpenChange}
        onModelChange={props.onModelChange}
        attachments={attachments}
        onAttachFiles={handleAttachFiles}
        onRemoveAttachment={handleRemoveAttachment}
        attachmentsEnabled={props.attachmentsEnabled}
        attachmentsDisabledReason={props.attachmentsDisabledReason}
        modelVariantLabel={props.modelVariantLabel}
        modelVariant={props.modelVariant}
        modelBehaviorOptions={props.modelBehaviorOptions}
        onModelVariantChange={props.onModelVariantChange}
        agentLabel={props.agentLabel}
        selectedAgent={props.selectedAgent}
        listAgents={props.listAgents}
        onSelectAgent={props.onSelectAgent}
        listCommands={props.listCommands}
        listSkills={listSkills}
        skills={toolSkills}
        listMcp={listMcp}
        mcpServers={toolMcpServers}
        mcpStatus={toolMcpStatus}
        mcpStatuses={toolMcpStatuses}
        listImportedPlugins={listImportedPlugins}
        importedPlugins={toolImportedPlugins}
        onOpenSettingsSection={props.onOpenSettingsSection}
        recentFiles={props.recentFiles}
        searchFiles={props.searchFiles}
        onInsertMention={handleInsertMention}
        inputHistory={inputHistory}
        onPasteText={handlePasteText}
        onUnsupportedFileLinks={handleUnsupportedFileLinks}
        pastedText={pasteParts}
        onExpandPastedText={handleExpandPastedText}
        onRemovePastedText={handleRemovePastedText}
        isRemoteWorkspace={props.isRemoteWorkspace}
          isSandboxWorkspace={props.isSandboxWorkspace}
          fusionEnabled={fusionEnabled}
          onToggleFusion={fusionAvailable ? handleToggleFusion : undefined}
          fusionModels={fusionAvailable ? fusionModels ?? [] : []}
          onFusionModelsChange={fusionAvailable ? handleFusionModelsChange : undefined}
          onToggleLiveTranscript={recorderActive ? handleToggleLiveTranscript : undefined}
          liveTranscriptActive={liveTranscriptActive}
          onUploadInboxFiles={props.onUploadInboxFiles ?? handleUploadInboxFiles}
          compactTopSpacing={Boolean(props.freeModelSelected || props.activeQuestion || (props.todos ?? []).some((todo) => todo.content.trim()) || props.activePermission || queuedMessages.length > 0)}
          topAccessory={
            props.freeModelSelected || props.activeQuestion || (props.todos ?? []).some((todo) => todo.content.trim()) || props.activePermission || queuedMessages.length > 0 ? (
              <div>
                {props.freeModelSelected ? <FreeModelNotice /> : null}
                {queuedMessages.length > 0 ? (
                  <QueuedMessagesPanel messages={queuedMessages} onRemove={removeQueuedDraft} />
                ) : null}
                {props.activeQuestion ? (
                  <QuestionPanel
                    questions={props.activeQuestion.questions}
                    busy={props.questionReplyBusy ?? false}
                    onReply={(answers) => {
                      if (props.activeQuestion) {
                        props.respondQuestion?.(props.activeQuestion.id, answers);
                      }
                    }}
                  />
                ) : (props.todos ?? []).some((todo) => todo.content.trim()) ? (
                  <TodoPanel todos={props.todos ?? []} />
                ) : null}
                {props.activePermission ? (
                  <PermissionApprovalPanel
                    permission={props.activePermission}
                    busy={props.permissionReplyBusy}
                    respondPermission={props.respondPermission}
                    safeStringify={props.safeStringify}
                  />
                ) : null}
              </div>
            ) : null
          }
        />
        </DevProfiler>
      </div>
      {/* Error display moved inline into the session conversation area */}
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
    </DevProfiler>
  );
}
