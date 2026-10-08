import { useProjectFiles } from "../../workspace/project-file-context";
import type { QueueInput } from "@legalwork/types/session-queue";
import { useSearchNavigation } from "@/react-app/shell/search-navigation";
/** @jsxImportSource react */
import { ProviderLimitMessage } from "@/react-app/domains/connections/usage-control/provider-limit-message";
import { hasAssistantReplyAfter } from "@/react-app/domains/connections/usage-control/usage-recovery";
import { isProviderUsageLimitError, providerFromUsageLimitError } from "@/app/lib/provider-usage-limit";
import { RecordingDetailDialog } from "../../recorder/recorder-pane";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

import { analyticsSurface, captureAnalyticsEvent, takeTaskRunStart } from "@/app/lib/analytics";
import { analyticsErrorService, analyticsErrorStatus } from "@/app/lib/analytics-error";
import {
  isEigenweltBudgetExceededErrorText,
} from "@/app/lib/eigenwelt-budget";
import {
  eigenweltBillingUrl,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";
import { eigenweltPlanWithoutModels, eigenweltTrialState } from "@/app/lib/eigenwelt-trial";
import { openDesktopUrl } from "@/app/lib/desktop";
import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSessionSafe } from "@/app/lib/opencode-session";
import { isOfficeAddinRuntime } from "@/app/lib/runtime-env";
import { t } from "@/i18n";
import { readWorkspaceImports, type ImportedPlugin } from "@/app/lib/extension-imports";
import {
  materializeLegalMemoryFile,
  materializeLegalMemoryFolder,
  type LegalMemoryFileDragItem,
  type LegalMemoryFolderDragItem,
} from "@/app/lib/legalmemory-file";
import {
  materializeStorageFile,
  type StorageFileDragItem,
} from "@/app/lib/storage-file-drag";
import type { WorkspaceFileDragItem } from "@/app/lib/workspace-file-drag";
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
import { hasUnfinishedTodos, TodoPanel } from "./todo-panel";
import {
  VoicePanel,
  type VoiceOpenCodeJobSnapshot,
} from "@/react-app/domains/session/voice/voice-panel";
import { collectVoiceActivity } from "@/react-app/domains/session/voice/voice-activity";
import {
  createLegalMemoryComposerMention,
  createLegalMemoryFolderComposerMention,
  decodeComposerMentionValue,
  encodeComposerMentionValue,
  legalMemoryComposerInstruction,
  legalMemoryComposerDisplayText,
  createStorageComposerMention,
  storageComposerInstruction,
  storageComposerDisplayText,
  reviewComposerDisplayText,
  reviewComposerInstruction,
  calendarComposerDisplayText,
  calendarComposerInstruction,
  taskComposerDisplayText,
  taskComposerInstruction,
  type ComposerMentionKind,
} from "./composer/mention-encoding";
import { desktopBridge } from "@/app/lib/desktop";
import { parseSlashCommandInvocation } from "./composer/slash-command";
import { DevProfiler } from "@/react-app/shell/dev-profiler";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { useReactRenderWatchdog } from "@/react-app/shell/react-render-watchdog";
import { SessionDebugPanel } from "./debug-panel";
import { deriveRenderedSessionMessages, resolveRenderedSessionSnapshot } from "./session-render-state";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useRecorderStore } from "@/react-app/domains/recorder/recorder-store";
import { parseWorkspaceAttachmentMention, createWorkspaceAttachmentMention, uploadWorkspaceAttachment, workspaceAttachmentDisplayText, workspaceAttachmentInstruction } from "./composer/workspace-attachment";
import { deriveSessionRenderModel } from "@/react-app/domains/session/sync/transition-controller";
import { useSessionScrollController } from "./scroll-controller";
import { PendingStatus } from "@/components/chat/pending-status";
import { SessionScrollOverlay } from "./scroll-overlay";
import { getSessionActivityStatusLabel, useSessionActivityStore, type SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store";
import { PermissionApprovalPanel } from "@/react-app/domains/session/chat/permission-approval-modal";
import { QuestionPanel } from "@/react-app/domains/session/modals/question-modal";
import { useSessionMessageQueue } from "./use-session-message-queue";
import { QueuedMessagesPanel } from "@/react-app/domains/session/modals/queued-messages-panel";
import { deriveOpenTargets, resolvePathOpenTarget, selectAutoOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store";
import {
  seedSessionState,
  seedTodoState,
  captureRunOutcome,
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
import { LEGALMEMORY_OPEN_EVENT, LEGALMEMORY_REF_EVENT } from "@/components/markdown/legalmemory-ref";
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
const VOICE_JOB_COMPLETION_SETTLE_MS = 3_000;

type SessionError = {
  message: string;
  kind?: "model-not-found" | "generic";
  /** For model-not-found: the model that failed. */
  failedModel?: { providerID: string; modelID: string };
  /** For model-not-found: suggested replacements from the backend. */
  suggestions?: Array<{ providerID: string; modelID: string }>;
};

export type SessionSurfaceProps = {
  /** Only the focused chat handles window-wide composer and voice events. */
  active?: boolean;
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
  /** Single provider serving a single model: plain model label, no Fusion. */
  modelSelectorLocked?: boolean;
  selectedModel: ModelRef;
  /** Open the connect-AI flow from the notice above the composer. */
  onConnectAi?: (action: ConnectAiAction) => void;
  onChooseAiPlan?: (plan: "plus" | "pro") => Promise<void>;
  /**
   * The route lays the plan screen over the app whenever no model is usable,
   * so the notice above the composer only covers what that screen leaves
   * open: a connected provider with no model picked, and a plan without
   * models while another provider works. Off in the Office task pane.
   */
  aiPlansGate?: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef) => void;
  onSendDraft: (draft: ComposerDraft, sessionId: string, options?: { waitForCompletion?: boolean; queue?: Omit<QueueInput, "execution"> }) => void | Promise<void>;
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
  realtimeVoiceSupported?: boolean;
  realtimeVoiceActive?: boolean;
  onRealtimeVoiceActiveChange?: (active: boolean) => void;
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

function assistantCanonicalText(message: UIMessage) {
  if (message.role !== "assistant") return "";
  return message.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("\n\n")
    .trim();
}

function messagesHaveRunningTool(messages: UIMessage[]) {
  return messages.some((message) => message.parts.some((part) => (
    part.type === "dynamic-tool" && part.state !== "output-available" && part.state !== "output-error"
  )));
}

function statusLabel(snapshot: LegalworkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return t("session.status_running");
  if (snapshot?.status.type === "busy") return t("session.status_running");
  if (snapshot?.status.type === "retry") {
    return t("session.status_retrying", { message: snapshot.status.message });
  }
  return t("session.status_ready");
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
  return <PendingStatus label={label} />;
}

/**
 * The ways out of "no usable model": trial sign-up, sign-in, bring your own,
 * or (a firm on a plan without models) upgrading.
 */
export type ConnectAiAction = "trial" | "login" | "byo" | "upgrade";

/**
 * Banner shown above the composer when there is no usable model (there is no
 * free fallback tier): nothing selected yet, or the selection points at a
 * provider that is no longer connected (signed out of Eigenwelt, access
 * revoked) with nothing else to switch to. Offers the three real paths: the
 * Eigenwelt trial, signing in to an existing account, or bringing your own
 * model/key. A firm subscribed to a plan without AI (none today) gets
 * "upgrade or bring your own" instead: it is signed in and paying already.
 *
 * On the desktop and the web the plan screen covers every state without a
 * usable model, so there the notice only asks to pick a model ("pick-model":
 * a provider is connected, nothing is selected) or offers that upgrade. The
 * Office task pane keeps the full notice while nothing is connected.
 */
function NoModelNotice(props: {
  /** "pick-model": a provider is connected, nothing is selected yet. */
  variant: "none" | "signed-out" | "no-ai-plan" | "pick-model";
  onConnect?: (action: ConnectAiAction) => void;
  onPickModel?: () => void;
}) {
  const primaryButtonClass =
    "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-fg transition-opacity hover:opacity-90";
  const secondaryButtonClass =
    "rounded-md border border-dls-border px-2.5 py-1 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover";
  if (props.variant === "pick-model") {
    return (
      <div className="flex flex-wrap items-center gap-2.5 border-b border-dls-border bg-dls-surface px-4 py-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-dls-secondary">
          <span className="font-medium text-dls-text">{t("chat.pick_model_title")}</span>{" "}
          {t("chat.pick_model_body")}
        </p>
        <button type="button" className={primaryButtonClass} onClick={() => props.onPickModel?.()}>
          {t("chat.pick_model_cta")}
        </button>
      </div>
    );
  }
  const title =
    props.variant === "no-ai-plan"
      ? t("chat.no_ai_plan_title")
      : props.variant === "signed-out"
        ? t("chat.signed_out_title")
        : t("chat.no_model_title");
  const body =
    props.variant === "no-ai-plan"
      ? t("chat.no_ai_plan_body")
      : props.variant === "signed-out"
        ? t("chat.signed_out_body")
        : t("chat.no_model_body");
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-dls-border bg-dls-surface px-4 py-3">
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-dls-secondary">
        <span className="font-medium text-dls-text">{title}</span> {body}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {props.variant === "no-ai-plan" ? (
          <button type="button" className={primaryButtonClass} onClick={() => props.onConnect?.("upgrade")}>
            {t("chat.no_ai_plan_upgrade")}
          </button>
        ) : (
          <>
            <button type="button" className={primaryButtonClass} onClick={() => props.onConnect?.("trial")}>
              {t("chat.no_model_trial")}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => props.onConnect?.("login")}>
              {t("chat.no_model_login")}
            </button>
          </>
        )}
        <button type="button" className={secondaryButtonClass} onClick={() => props.onConnect?.("byo")}>
          {t("chat.no_model_byo")}
        </button>
      </div>
    </div>
  );
}

/**
 * Banner shown above the composer when the selected model still points at the
 * Eigenwelt provider but the firm's free trial has lapsed — the paid gateway
 * is blocked, so sends would fail with a missing model. Offers the subscribe
 * path; picking another model also clears it.
 */
function TrialEndedNotice(props: { billingUrl: string }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-dls-border bg-amber-2/40 px-4 py-3">
      <TriangleAlert size={14} className="shrink-0 text-amber-11" />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-amber-11">
        <span className="font-medium">{t("trial.notice_title")}</span>{" "}
        {t("trial.notice_body")}
      </p>
      <button
        type="button"
        className="shrink-0 rounded-md border border-amber-11/30 px-2 py-1 text-xs font-medium text-amber-11 transition-colors hover:bg-amber-11/10"
        onClick={() => void openDesktopUrl(props.billingUrl)}
      >
        {t("trial.notice_cta")}
      </button>
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
                  {t("session.change_model")}
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-red-10 transition-colors hover:bg-red-3 hover:text-red-11"
            onClick={onDismiss}
            aria-label={t("session.dismiss_error")}
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

export function SessionSurface(props: SessionSurfaceProps) {
  const projectFiles = useProjectFiles();
  const local = useLocal();
  const { config: shellConfig } = useShellConfig();
  // No model connected at all (free tier retired): offer trial / BYO inline.
  const noModelNoticeVisible = !props.selectedModel.providerID;
  // The selection points at a provider that is no longer connected and
  // nothing else is; refined below once the trial state is known.
  const lockedOutCandidate =
    !noModelNoticeVisible &&
    Boolean(props.modelUnavailable) &&
    (props.providerConnectedCount ?? 0) === 0;
  const eigenweltEntitlementsQuery = useEigenweltEntitlements({
    client: props.client,
    workspaceId: props.workspaceId,
    // Also needed while a connect notice may show: a firm on the Knowledge
    // Hub plan is signed in with no model and gets its own wording.
    enabled:
      props.selectedModel.providerID === "eigenwelt" || noModelNoticeVisible || lockedOutCandidate,
  });
  const eigenweltPlan = eigenweltEntitlementsQuery.data?.entitlements?.plan ?? null;
  // Trial lapsed while the selection still points at the Eigenwelt provider:
  // the paid gateway is blocked, so surface the subscribe path instead of
  // letting sends fail on a vanished model.
  const eigenweltTrial = eigenweltTrialState(eigenweltEntitlementsQuery.data?.entitlements ?? null);
  const trialEndedNoticeVisible =
    props.selectedModel.providerID === "eigenwelt" && eigenweltTrial.kind === "ended";
  const trialBillingUrl = eigenweltBillingUrl(eigenweltEntitlementsQuery.data?.platformURL ?? null);
  // Locked out: the selection points at a provider that is no longer
  // connected (signed out of Eigenwelt, access revoked, provider removed) and
  // nothing else is connected, so there is no model to switch to. Same ways
  // out as "no model"; a lapsed trial keeps its own subscribe notice.
  const lockedOutNoticeVisible = lockedOutCandidate && !trialEndedNoticeVisible;
  // Signed in to a firm on a plan without models: subscribed, but the plan
  // has no Eigenwelt models, so neither "start a trial" nor "log in" applies.
  // Also shown while the selection still points at the Eigenwelt provider
  // (a firm moved down from Plus keeps the model in the picker until the
  // engine config is rebuilt; the gateway already rejects it).
  const planWithoutModels =
    (eigenweltEntitlementsQuery.data?.connected ?? false) &&
    eigenweltPlanWithoutModels(eigenweltEntitlementsQuery.data?.entitlements ?? null);
  const noAiPlanNoticeVisible =
    planWithoutModels &&
    !trialEndedNoticeVisible &&
    (noModelNoticeVisible || lockedOutCandidate || props.selectedModel.providerID === "eigenwelt");
  // A provider is connected and nothing is picked yet: ask for a pick, not a
  // connection. Under the plan screen this is the only "no model" notice
  // (every other state without a usable model is the plan screen's). The
  // Office task pane lands here on first open: its model choice is stored per
  // origin, apart from the app's.
  const pickModelNoticeVisible = noModelNoticeVisible && (props.providerConnectedCount ?? 0) > 0;
  const connectNoticeVisible = props.aiPlansGate
    ? noAiPlanNoticeVisible || pickModelNoticeVisible
    : noModelNoticeVisible || lockedOutNoticeVisible || noAiPlanNoticeVisible;
  // While nothing can serve the prompt (no selection, a selection on a
  // provider that is gone, or a plan without models), lock the composer
  // exactly as a vanished model does, so the notice's buttons or the plan
  // screen are the way forward instead of a send that fails inside the
  // engine. Read from those conditions, not from which notice shows: under
  // the plan screen most of them show none. The red "model no longer
  // available" label stays tied to `modelUnavailable` alone; an empty
  // selection has no model to flag.
  const sendBlocked =
    Boolean(props.modelUnavailable) ||
    noModelNoticeVisible ||
    lockedOutNoticeVisible ||
    noAiPlanNoticeVisible;
  const connectNoticeVariant = noAiPlanNoticeVisible
    ? "no-ai-plan"
    : props.aiPlansGate || pickModelNoticeVisible
      ? "pick-model"
      : lockedOutNoticeVisible && props.selectedModel.providerID === "eigenwelt"
        ? "signed-out"
        : "none";
  // "Upgrade to Plus" opens the firm's billing page; everything else is the
  // route's business (sign-in flows, the provider picker).
  const onConnectAi = (action: ConnectAiAction) => {
    if (action === "upgrade") {
      void openDesktopUrl(trialBillingUrl);
      return;
    }
    props.onConnectAi?.(action);
  };
  const showThinking = local.prefs.showThinking;
  const sessionActivityStatus = useSessionActivityStore(
    (state) => state.statusesByWorkspaceId[props.workspaceId]?.[props.sessionId] ?? "idle",
  );
  const sessionActivityError = useSessionActivityStore(
    (state) => state.recordsByWorkspaceId[props.workspaceId]?.[props.sessionId]?.errorMessage ?? null,
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
  const sharedQueue = useSessionMessageQueue(props.client, props.workspaceId, props.sessionId);
  const [queueSaving, setQueueSaving] = useState(false);
  const queueSubmitting = useRef(false);
  const queuedDrafts = useComposerStateStore((state) => getComposerQueuedDrafts(state, props.sessionId));
  const editingQueuedDraftId = useComposerStateStore((state) => state.sessions[props.sessionId]?.queuedDraftId);
  const officeAddinRuntime = isOfficeAddinRuntime();
  const fusionDefaultModels = local.prefs.fusionModels;
  // Show Fusion only after candidate models have been configured in Settings.
  const fusionAvailable = !officeAddinRuntime && !props.modelSelectorLocked && (fusionDefaultModels?.length ?? 0) > 0;
  const storedFusionEnabled = useFusionStore((state) => Boolean(state.enabledSessionIds[props.sessionId]));
  const fusionEnabled = fusionAvailable && storedFusionEnabled;
  const fusionModels = useFusionStore((state) => state.selectedModelsBySessionId[props.sessionId]);
  const setFusionEnabled = useFusionStore((state) => state.setEnabled);
  const setFusionModels = useFusionStore((state) => state.setSelectedModels);
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
  const removeQueuedDraftFromStore = useComposerStateStore((state) => state.removeQueuedDraft);
  const queuePaused = useComposerStateStore((state) => Boolean(state.pausedQueues[props.sessionId]));
  const [error, setError] = useState<SessionError | null>(null);
  const [sending, setSending] = useState(false);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
  const [awaitingAssistantBaseline, setAwaitingAssistantBaseline] = useState<number | null>(null);
  const [voiceJob, setVoiceJob] = useState<(VoiceOpenCodeJobSnapshot & {
    workspaceId: string;
    sessionId: string;
    baseline: number;
    observedRun: boolean;
  }) | null>(null);
  const voiceJobRef = useRef(voiceJob);
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
  const searchTarget = useSearchNavigation(state => state.target);
  const searchMessageId = searchTarget?.kind === "sessions" && searchTarget.id === props.sessionId && searchTarget.workspaceId === props.workspaceId ? searchTarget.messageId : undefined;
  const fullHistorySession = useRef<string | null>(null);
  if (searchMessageId) fullHistorySession.current = props.sessionId;
  const snapshotQuery = useQuery<LegalworkSessionSnapshot>({
    queryKey: snapshotQueryKey,
    queryFn: async () => {
      const startedAt = Date.now();
      const snapshot = (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, fullHistorySession.current === props.sessionId ? undefined : { limit: 140 })).item;
      seedTodoState(props.workspaceId, props.sessionId, snapshot.todos, startedAt);
      return snapshot;
    },
    staleTime: 500,
  });

  const currentSnapshot = snapshotQuery.data?.session.id === props.sessionId ? snapshotQuery.data : null;
  const transcriptState = useSharedQueryState<UIMessage[]>(transcriptQueryKey, EMPTY_TRANSCRIPT);
  // SSE can miss the initial busy event (especially after a workspace switch).
  // Reconcile the visible session with the engine, independently of transcript snapshots.
  const statusQuery = useQuery<SessionStatus>({
    queryKey: statusQueryKey,
    queryFn: async () => {
      const startedAt = Date.now();
      const statuses = unwrap(await opencodeClient.session.status({ directory: props.workspaceRoot.trim() || undefined }));
      const activity = useSessionActivityStore.getState().recordsByWorkspaceId[props.workspaceId]?.[props.sessionId];
      // A prompt submitted while this request was in flight supersedes its idle result.
      if (activity?.runActive && activity.updatedAt > startedAt) return { type: "busy" };
      const status = statuses[props.sessionId] ?? IDLE_STATUS;
      useSessionActivityStore.getState().setRunStatus(props.workspaceId, props.sessionId, status);
      return status;
    },
    refetchInterval: 2_000,
    refetchOnWindowFocus: "always",
  });
  const statusState = statusQuery.data ?? currentSnapshot?.status ?? IDLE_STATUS;
  const hasActivePlan = hasUnfinishedTodos(props.todos ?? []);

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
  const activityRunning = sessionActivityStatus !== "idle" && sessionActivityStatus !== "error";
  const chatStreaming = sending || activityRunning || liveStatus.type === "busy" || liveStatus.type === "retry";
  const status = useMemo((): ThreadStatus => {
    if (sending) {
      return "submitted";
    }

    if (liveStatus.type === "retry") {
      return "retrying";
    }

    if (chatStreaming) return "streaming";

    return "ready";
  }, [liveStatus, sending, chatStreaming]);

  // A quota failure requires user action. Stop on its first retry event.
  const paidBudgetRetryActive = liveStatus.type === "retry" && isProviderUsageLimitError(liveStatus.message, props.selectedModel.providerID);
  const retryStatusForDisplay = liveStatus.type === "retry" && !paidBudgetRetryActive ? liveStatus : null;
  const renderedMessages = useMemo(
    () => deriveRenderedSessionMessages({ transcriptState, snapshot }),
    [snapshot, transcriptState],
  );
  const queryClient = useQueryClient();
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
    if (props.active === false) return;
    if (!autoOpenTarget || chatStreaming) return;
    if (autoOpenedTargetRef.current === autoOpenTarget.id) return;
    autoOpenedTargetRef.current = autoOpenTarget.id;
    props.onOpenTarget?.(autoOpenTarget, { auto: true }, props.sessionId);
  }, [props.active, autoOpenTarget, chatStreaming, props.onOpenTarget, props.sessionId]);

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

  const buildDraft = useCallback((text: string, nextAttachments: ComposerAttachment[], draftMentions = mentions): ComposerDraft => {
    const modelContexts: string[] = [];
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
        const kind = draftMentions[value];
        if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "upload") {
          modelContexts.push(workspaceAttachmentInstruction(value));
          return [{ type: "text", text: workspaceAttachmentDisplayText(value) } satisfies ComposerDraft["parts"][number]];
        }
        if (kind === "memory") {
          modelContexts.push(legalMemoryComposerInstruction(value));
          return [{ type: "text", text: legalMemoryComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
        }
        if (kind === "storage") {
          modelContexts.push(storageComposerInstruction(value));
          return [{ type: "text", text: storageComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
        }
        if (kind === "review") {
          modelContexts.push(reviewComposerInstruction(value));
          return [{ type: "text", text: reviewComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
        }
        if (kind === "calendar") {
          modelContexts.push(calendarComposerInstruction(value));
          return [{ type: "text", text: calendarComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
        }
        if (kind === "task") {
          modelContexts.push(taskComposerInstruction(value));
          return [{ type: "text", text: taskComposerDisplayText(value) } satisfies ComposerDraft["parts"][number]];
        }
        if (kind === "app") return [{ type: "app", name: value } satisfies ComposerDraft["parts"][number]];
      }
      return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
    });
    // Expand paste placeholders in resolvedText so the model receives
    // the actual pasted content instead of "[pasted text <label>]".
    let resolved = text;
    for (const part of pasteParts) {
      resolved = resolved.replace(`[pasted text ${part.label}]`, () => part.text);
    }
    resolved = resolved.replace(/\[skill ([^\]]+)\]/g, (_match, name: string) => `the \"${name}\" skill`);
    for (const [value, kind] of Object.entries(draftMentions)) {
      resolved = resolved.replaceAll(
        `@${encodeComposerMentionValue(value)}`,
        kind === "memory"
          ? legalMemoryComposerDisplayText(value)
          : kind === "storage"
            ? storageComposerDisplayText(value)
            : kind === "review"
              ? reviewComposerDisplayText(value)
            : kind === "calendar"
              ? calendarComposerDisplayText(value)
            : kind === "task"
              ? taskComposerDisplayText(value)
              : kind === "upload"
                ? workspaceAttachmentDisplayText(value)
                : `@${value}`,
      );
    }
    const slashCommand = parseSlashCommandInvocation(resolved);
    return {
      mode: "prompt",
      parts,
      attachments: nextAttachments,
      text,
      resolvedText: resolved,
      modelContext: [...new Set(modelContexts)].join("\n") || undefined,
      command: slashCommand ?? undefined,
    };
  }, [mentions, pasteParts]);

  const preparedProjectDraft = useRef<{ signature: string; draft: ComposerDraft; mentions: typeof mentions } | null>(null);
  const prepareProjectAttachments = async (text: string, nextAttachments: ComposerAttachment[]) => {
    // Reusing the captured bytes on retries also keeps the queue's idempotency key stable.
    const signature = JSON.stringify([props.client.baseUrl, props.workspaceId, props.sessionId, text, mentions, pasteParts, nextAttachments.map(attachment => attachment.id)]);
    if (preparedProjectDraft.current?.signature === signature) return preparedProjectDraft.current;
    const prepared = { ...mentions };
    let resolved = text;
    for (const [value, kind] of Object.entries(mentions)) {
      const token = `@${encodeComposerMentionValue(value)}`;
      if (kind !== "upload" || !resolved.includes(token)) continue;
      const attachment = parseWorkspaceAttachmentMention(value);
      if (!attachment?.source) continue;
      if (!projectFiles) throw new Error(t("project_files.source_unavailable"));
      const source = attachment.source;
      const saved = await projectFiles.readSaved(source);
      const reference = await uploadWorkspaceAttachment(props.client, props.workspaceId, new File([saved.data], source.name, { type: saved.contentType ?? "application/octet-stream" }), `${source.name} · ${saved.projectName}`);
      const versioned = `${reference}&${new URLSearchParams({ origin: saved.projectName, version: saved.version, originProject: source.projectId, originPath: source.path })}`;
      resolved = resolved.replaceAll(token, `@${encodeComposerMentionValue(versioned)}`);
      delete prepared[value]; prepared[versioned] = "upload";
    }
    const result = { signature, draft: buildDraft(resolved, nextAttachments, prepared), mentions: prepared };
    preparedProjectDraft.current = result;
    return result;
  };

  const handleComposerDraftChange = useCallback((value: string) => {
    setComposerDraft(props.sessionId, value);
  }, [props.sessionId, setComposerDraft]);

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(renderedMessages));
    } catch (nextError) {
      setError({ message: nextError instanceof Error ? nextError.message : t("session.copy_transcript_failed") });
    }
  };

  // Send an idle-session prompt. Busy-session input is queued below.
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
      setAwaitingAssistantBaseline(null);
      setSending(false);
      throw nextError;
    }
  }, [appendComposerHistory, props.onSendDraft, props.sessionId, props.workspaceId, renderedMessages.length, setComposerDraft]);

  const clearComposer = useCallback(() => {
    clearComposerSession(props.sessionId);
    props.onDraftChange(buildDraft("", []));
  }, [buildDraft, clearComposerSession, props.onDraftChange, props.sessionId]);

  const queueFailure = (error: unknown) => toast.error(t("composer.queue_failed"), { description: error instanceof Error ? error.message : String(error) });
  const handleQueue = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || queueSubmitting.current) return;
    queueSubmitting.current = true; setQueueSaving(true);
    const editor = useComposerStateStore.getState().sessions[props.sessionId];
    try {
      const prepared = await prepareProjectAttachments(text, attachments);
      await sharedQueue.enqueue(prepared.draft, async queue => { await props.onSendDraft(prepared.draft, props.sessionId, { queue }); }, { ...editor, mentions: prepared.mentions });
      preparedProjectDraft.current = null;
      // Typing during the request must not be cleared by its acknowledgement.
      if (useComposerStateStore.getState().sessions[props.sessionId] === editor) clearComposer();
      else if (editor?.queuedDraftId) {
        // The submitted edit is complete. Preserve anything typed meanwhile as
        // this window's new draft, without retaining an expired queue lease.
        useComposerStateStore.setState(state => {
          const current = state.sessions[props.sessionId];
          if (!current || current.queuedDraftId !== editor.queuedDraftId) return state;
          return { sessions: { ...state.sessions, [props.sessionId]: { ...current, queuedDraftId: undefined } } };
        });
      }
      appendComposerHistory(props.sessionId, text);
    } catch (error) { queueFailure(error); }
    finally { queueSubmitting.current = false; setQueueSaving(false); }
  };
  const handleSend = handleQueue;
  const removeQueuedDraft = (id: string) => { void sharedQueue.remove(id).catch(queueFailure); };
  const editQueuedDraft = (id: string) => { void sharedQueue.edit(id).then(() => window.dispatchEvent(new Event("legalwork:focusPrompt"))).catch(queueFailure); };
  const cancelQueuedEdit = () => { void sharedQueue.cancelEdit().then(clearComposer).catch(queueFailure); };
  const reorderQueuedDrafts = async (ids: string[]) => { await sharedQueue.reorder(ids).catch(queueFailure); };
  const resumeQueue = () => { void sharedQueue.pause(false).then(() => useSessionActivityStore.getState().clearError(props.workspaceId, props.sessionId)).catch(queueFailure); };

  const handleAbort = useCallback(async () => {
    if (!chatStreaming) return;
    setError(null);
    // Pause first so the next queued message cannot restart an aborted turn.
    try { await sharedQueue.pause(true, "stop"); } catch (error) { queueFailure(error); return; }
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
    setSending(false);
    setAwaitingAssistantBaseline(null);
    useSessionActivityStore.getState().clearError(props.workspaceId, props.sessionId);
    useSessionActivityStore.getState().setRunStatus(props.workspaceId, props.sessionId, IDLE_STATUS);
    queryClient.setQueryData(statusQueryKey, IDLE_STATUS);
    // Take the run-start marker here so this stop is the run's single
    // terminal event. The engine may or may not follow an abort with
    // `session.idle` / `session.error` — on most stops it emitted neither,
    // which left the run with no stats-bearing event at all; on the rest it
    // would now emit a second one and double-count the tokens. It also keeps
    // `task_run_errored` meaning a genuine failure rather than "failed, or
    // the user pressed stop".
    const runStartedAt = takeTaskRunStart(props.sessionId);
    // Refresh first: the stats must cover the work done up to the abort, and
    // the cached snapshot still predates it. `captureRunOutcome` then reads
    // this result instead of refetching again.
    try {
      await snapshotQuery.refetch();
    } catch {
      // Stale stats beat no event: the marker is already spent, so bailing
      // here would lose this run's accounting entirely.
    }
    captureRunOutcome(
      props.workspaceId,
      props.sessionId,
      "task_run_stopped",
      { duration_ms: runStartedAt === null ? null : Date.now() - runStartedAt },
      { refresh: false },
    );
  }, [chatStreaming, sharedQueue, opencodeClient, props.sessionId, props.workspaceId, props.workspaceRoot, snapshotQuery.refetch, statusQueryKey, queryClient]);

  const startVoiceJob = useCallback(async (request: string) => {
    const text = request.trim();
    if (!text) throw new Error(t("session.voice_request_empty"));
    const current = voiceJobRef.current;
    if (current && !["completed", "cancelled", "error"].includes(current.status)) {
      unwrap(await opencodeClient.session.promptAsync({
        sessionID: props.sessionId,
        directory: props.workspaceRoot.trim() || undefined,
        model: props.selectedModel,
        agent: props.selectedAgent ?? undefined,
        parts: [{ type: "text", text }],
      }));
      return { jobId: current.id };
    }
    if (chatStreaming) {
      throw new Error(t("session.voice_still_working"));
    }

    const jobId = `voice_${crypto.randomUUID()}`;
    const job = {
      id: jobId,
      status: "queued" as const,
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      baseline: renderedMessages.length,
      observedRun: false,
    };
    voiceJobRef.current = job;
    setVoiceJob(job);
    setAwaitingAssistantBaseline(renderedMessages.length);
    useSessionActivityStore.getState().setRunStatus(props.workspaceId, props.sessionId, { type: "busy" });

    // Work selected by the voice conversation enters the same canonical
    // session and follows its normal event and transcript path.
    void (async () => {
      try {
        unwrap(await opencodeClient.session.promptAsync({
          sessionID: props.sessionId,
          directory: props.workspaceRoot.trim() || undefined,
          model: props.selectedModel,
          agent: props.selectedAgent ?? undefined,
          parts: [{ type: "text", text }],
        }));
      } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : String(jobError);
        setVoiceJob((activeJob) => {
          if (!activeJob || activeJob.id !== jobId) return activeJob;
          const failed = { ...activeJob, status: "error" as const, error: message };
          voiceJobRef.current = failed;
          return failed;
        });
        useSessionActivityStore.getState().setError(props.workspaceId, props.sessionId, message);
      }
    })();

    return { jobId };
  }, [chatStreaming, opencodeClient, props.selectedAgent, props.selectedModel, props.sessionId, props.workspaceId, props.workspaceRoot, renderedMessages.length]);

  useEffect(() => {
    voiceJobRef.current = voiceJob;
  }, [voiceJob]);

  useEffect(() => {
    setVoiceJob((current) => {
      if (!current || (current.workspaceId === props.workspaceId && current.sessionId === props.sessionId)) return current;
      voiceJobRef.current = null;
      return null;
    });
  }, [props.sessionId, props.workspaceId]);

  useEffect(() => {
    setVoiceJob((current) => {
      if (!current || ["completed", "cancelled", "error"].includes(current.status)) return current;
      if (sessionActivityStatus === "error") {
        const failed = { ...current, status: "error" as const, error: sessionActivityError || "I couldn’t complete that request." };
        voiceJobRef.current = failed;
        return failed;
      }

      const jobMessages = renderedMessages.slice(current.baseline);
      const observedRun = current.observedRun || effectiveActivityStatus !== "idle" || jobMessages.length > 0;

      let status: VoiceOpenCodeJobSnapshot["status"] = current.status;
      if (effectiveActivityStatus === "waiting") status = "waiting_approval";
      else if (messagesHaveRunningTool(jobMessages)) status = "tool_use";
      else if (effectiveActivityStatus !== "idle") status = "thinking";

      if (status === current.status && observedRun === current.observedRun) {
        return current;
      }
      const next = {
        ...current,
        status,
        observedRun,
      };
      voiceJobRef.current = next;
      return next;
    });
  }, [effectiveActivityStatus, renderedMessages, sessionActivityError, sessionActivityStatus]);

  useEffect(() => {
    const current = voiceJobRef.current;
    if (
      !current
      || ["completed", "cancelled", "error"].includes(current.status)
      || !current.observedRun
      || effectiveActivityStatus !== "idle"
    ) return;
    const jobMessages = renderedMessages.slice(current.baseline);
    if (messagesHaveRunningTool(jobMessages)) return;
    const canonicalResult = jobMessages
      .map(assistantCanonicalText)
      .filter(Boolean)
      .at(-1) ?? "";
    if (!canonicalResult) return;

    const jobId = current.id;
    const timer = window.setTimeout(() => {
      setVoiceJob((activeJob) => {
        if (!activeJob || activeJob.id !== jobId || ["completed", "cancelled", "error"].includes(activeJob.status)) {
          return activeJob;
        }
        const completed = { ...activeJob, status: "completed" as const, result: canonicalResult };
        voiceJobRef.current = completed;
        return completed;
      });
    }, VOICE_JOB_COMPLETION_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [effectiveActivityStatus, renderedMessages]);

  const voiceActivity = useMemo(() => (
    voiceJob ? collectVoiceActivity(renderedMessages.slice(voiceJob.baseline)) : []
  ), [renderedMessages, voiceJob]);

  const handleDismissError = useCallback(() => {
    setError(null);
    useSessionActivityStore.getState().clearError(props.workspaceId, props.sessionId);
  }, [props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (liveStatus.type === "idle") {
      setSending(false);
    }
  }, [liveStatus.type]);

  useEffect(() => {
    props.onDraftChange(buildDraft(draft, attachments));
  }, [attachments, buildDraft, draft, props.onDraftChange]);

  const [pendingAttachmentUploads, setPendingAttachmentUploads] = useState(0);

  const handleAttachFiles = async (files: File[]) => {
    if (!props.attachmentsEnabled) {
      toast.warning(props.attachmentsDisabledReason ?? "Attachments are unavailable.");
      return;
    }
    setPendingAttachmentUploads((count) => count + files.length);
    for (const file of files) {
      const notification = toast.info(`Attaching ${file.name}…`, { duration: Infinity });
      try {
        const reference = await uploadWorkspaceAttachment(props.client, props.workspaceId, file);
        const state = useComposerStateStore.getState();
        const currentDraft = getComposerDraft(state, props.sessionId);
        const currentMentions = getComposerMentions(state, props.sessionId);
        const separator = currentDraft && !/\s$/.test(currentDraft) ? " " : "";
        setComposerDraft(props.sessionId, `${currentDraft}${separator}@${encodeComposerMentionValue(reference)} `);
        setComposerMentions(props.sessionId, { ...currentMentions, [reference]: "upload" });
        void queryClient.invalidateQueries({ queryKey: ["workspace-files", props.workspaceId] });
        toast.dismiss(notification);
      } catch (error) {
        toast.error(t("session.attach_failed", { name: file.name }), {
          id: notification,
          description: error instanceof Error ? error.message : t("session.file_upload_failed"),
        });
      } finally {
        setPendingAttachmentUploads((count) => count - 1);
      }
    }
  };

  const handleRemoveAttachment = (id: string) => {
    const target = attachments.find((item) => item.id === id);
    if (target?.previewUrl && !queuedDrafts.some((item) => item.attachments.some((attachment) => attachment.previewUrl === target.previewUrl))) {
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

  /** Insert a memory pill without disturbing the draft the user is typing. */
  const appendMemoryMention = (reference: string) => {
    const composerState = useComposerStateStore.getState();
    const currentDraft = getComposerDraft(composerState, props.sessionId);
    const currentMentions = getComposerMentions(composerState, props.sessionId);
    const separator = currentDraft && !/\s$/.test(currentDraft) ? " " : "";
    setComposerDraft(props.sessionId, `${currentDraft}${separator}@${encodeComposerMentionValue(reference)} `);
    setComposerMentions(props.sessionId, { ...currentMentions, [reference]: "memory" });
  };

  const handleDropLegalMemoryFile = async (file: LegalMemoryFileDragItem) => {
    try {
      // Materialize the authorized original before inserting the pill. Only its
      // workspace path is sent to the agent; the binary is deliberately not
      // added to ComposerDraft.attachments or emitted as a file part.
      const result = await materializeLegalMemoryFile(props.client, props.workspaceId, file.document_id);
      appendMemoryMention(createLegalMemoryComposerMention(file.document_id, file.name, result.path));
    } catch (error) {
      toast.error(t("session.download_failed", { name: file.name }), {
        description: error instanceof Error ? error.message : t("session.legalmemory_download_failed"),
      });
    }
  };

  const handleDropLegalMemoryFolder = async (folder: LegalMemoryFolderDragItem) => {
    // A folder is many downloads, so unlike a single file it needs to say it is
    // working; the toast is dismissed by id once the copy lands.
    const pending = toast.info(t("session.legalmemory_folder_downloading", { name: folder.name }), {
      duration: Infinity,
    });
    try {
      const result = await materializeLegalMemoryFolder(props.client, props.workspaceId, folder);
      toast.dismiss(pending);
      if (!result.files) {
        toast.error(t("session.legalmemory_folder_empty", { name: folder.name }));
        return;
      }
      appendMemoryMention(
        createLegalMemoryFolderComposerMention(folder.source_id, folder.name, result.path, result.files),
      );
      if (result.truncated || result.skipped) {
        toast.warning(t("session.legalmemory_folder_partial", { name: folder.name, count: String(result.files) }));
      }
    } catch (error) {
      toast.dismiss(pending);
      toast.error(t("session.legalmemory_folder_failed", { name: folder.name }), {
        description: error instanceof Error ? error.message : t("session.legalmemory_download_failed"),
      });
    }
  };

  const handleDropStorageFile = async (file: StorageFileDragItem) => {
    try {
      // Check the object out, then insert a storage pill that carries the
      // workspace path as metadata. Same contract as the LegalMemory pill: the
      // agent is told to open the copy with a format-appropriate tool, so an
      // xlsx is never handed to a plain-text reader, and the badge shows the
      // filename instead of the checkout path.
      const copy = await materializeStorageFile(props.client, props.workspaceId, file);
      const reference = createStorageComposerMention(file.connectionId, file.path, file.name, copy.localPath);
      const composerState = useComposerStateStore.getState();
      const currentDraft = getComposerDraft(composerState, props.sessionId);
      const currentMentions = getComposerMentions(composerState, props.sessionId);
      const separator = currentDraft && !/\s$/.test(currentDraft) ? " " : "";
      setComposerDraft(
        props.sessionId,
        `${currentDraft}${separator}@${encodeComposerMentionValue(reference)} `,
      );
      setComposerMentions(props.sessionId, { ...currentMentions, [reference]: "storage" });
    } catch (error) {
      toast.error(t("session.download_failed", { name: file.name }), {
        description: error instanceof Error ? error.message : t("session.storage_download_failed"),
      });
    }
  };

  const handleDropWorkspaceFile = async (file: WorkspaceFileDragItem) => {
    try {
      let reference: string;
      if (file.workspaceId === props.workspaceId) {
        // Already in this project: reference the original, just as a storage
        // drop references its checked-out file, without a binary model upload.
        const stat = await props.client.statWorkspaceFile(props.workspaceId, file.path);
        if (!stat.exists || stat.kind !== "file") throw new Error(t("composer.workspace_file_unavailable"));
        reference = createWorkspaceAttachmentMention(file.name, file.path);
      } else {
        // A file from another project needs a copy the current agent can read.
        const download = await props.client.downloadWorkspaceFile(file.workspaceId, file.path);
        const filename = file.path.split(/[\\/]/).pop() || file.name;
        const copy = new File([download.data], filename, { type: download.contentType ?? "application/octet-stream" });
        reference = await uploadWorkspaceAttachment(props.client, props.workspaceId, copy, file.name);
        void queryClient.invalidateQueries({ queryKey: ["workspace-files", props.workspaceId] });
      }
      const state = useComposerStateStore.getState();
      const currentDraft = getComposerDraft(state, props.sessionId);
      const currentMentions = getComposerMentions(state, props.sessionId);
      const separator = currentDraft && !/\s$/.test(currentDraft) ? " " : "";
      setComposerDraft(props.sessionId, `${currentDraft}${separator}@${encodeComposerMentionValue(reference)} `);
      setComposerMentions(props.sessionId, { ...currentMentions, [reference]: "upload" });
    } catch (error) {
      toast.error(t("session.attach_failed", { name: file.name }), {
        description: error instanceof Error ? error.message : t("composer.workspace_file_unavailable"),
      });
    }
  };

  const handlePasteText = (text: string) => {
    const id = `paste-${Math.random().toString(36).slice(2)}`;
    const lines = text.split(/\r?\n/).length;
    const part = { id, label: `${id.slice(-4)} · ${lines} lines`, text, lines };
    const current = getComposerPasteParts(useComposerStateStore.getState(), props.sessionId);
    setComposerPasteParts(props.sessionId, [...current, part]);
    return part;
  };

  const handleExpandPastedText = (id: string) => {
    const state = useComposerStateStore.getState();
    const currentParts = getComposerPasteParts(state, props.sessionId);
    const part = currentParts.find((item) => item.id === id);
    if (!part) return;
    const currentDraft = getComposerDraft(state, props.sessionId);
    setComposerDraft(props.sessionId, currentDraft.replace(`[pasted text ${part.label}]`, () => part.text));
    setComposerPasteParts(props.sessionId, currentParts.filter((item) => item.id !== id));
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
      if (props.active === false) return;
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
  }, [props.active, attachments, buildDraft, props.onDraftChange, props.sessionId, props.workspaceId, typeComposerText]);

  // A LegalMemory reference chip in the transcript was clicked: send the
  // built fetch/preview prompt as its own turn (steering mid-run is fine —
  // see sendDraft). If sending is impossible, leave the prompt in the
  // composer so the click still visibly did something.
  useEffect(() => {
    const handleLegalMemoryRef = (event: Event) => {
      if (props.active === false) return;
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== "object" || Array.isArray(detail) || !("prompt" in detail) || typeof detail.prompt !== "string") return;
      const prompt = detail.prompt;
      const seedComposer = async () => {
        await typeComposerText(prompt);
        props.onDraftChange(buildDraft(prompt, attachments));
      };
      if (sendBlocked) {
        void seedComposer();
        return;
      }
      void sendDraft(buildDraft(prompt, []), []).catch(() => seedComposer());
    };
    window.addEventListener(LEGALMEMORY_REF_EVENT, handleLegalMemoryRef);
    return () => window.removeEventListener(LEGALMEMORY_REF_EVENT, handleLegalMemoryRef);
  }, [props.active, attachments, buildDraft, sendBlocked, props.onDraftChange, sendDraft, typeComposerText]);

  // A LegalMemory source was clicked. The server pulls the original over MCP
  // and drops it in the workspace, then we open it. The agent is not involved:
  // fetching a file the user asked for is the app's job, not a task for a model.
  useEffect(() => {
    const handleLegalMemoryOpen = (event: Event) => {
      if (props.active === false) return;
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== "object" || !("documentId" in detail) || typeof detail.documentId !== "string") return;
      const documentId = detail.documentId;
      const workspaceId = props.workspaceId;
      if (!workspaceId) return;
      void (async () => {
        try {
          const result = await materializeLegalMemoryFile(props.client, workspaceId, documentId);
          const target = resolvePathOpenTarget(result.path, openTargets, "legalmemory");
          if (!target) return;
          // The viewer caches per target id. This path may have been opened
          // before the document existed (a failed export leaves the miss
          // cached), so drop that entry or the pane renders the old result for
          // a file we just wrote.
          queryClient.removeQueries({ queryKey: ["artifact-panel", workspaceId, target.id] });
          props.onOpenTarget?.(target);
        } catch (error) {
          const label = "label" in detail && typeof detail.label === "string" ? detail.label : t("session.that_document");
          toast.error(t("session.open_failed", { name: label }), {
            description: error instanceof Error ? error.message : t("session.legalmemory_download_failed"),
          });
        }
      })();
    };
    window.addEventListener(LEGALMEMORY_OPEN_EVENT, handleLegalMemoryOpen);
    return () => window.removeEventListener(LEGALMEMORY_OPEN_EVENT, handleLegalMemoryOpen);
  }, [props.active, openTargets, props.client, props.onOpenTarget, props.workspaceId, queryClient]);

  const composerSetTextControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "composer.set_text",
    label: t("control.type_composer"),
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
    label: t("control.send_composer"),
    description: "Send the currently visible composer draft to the active session.",
    sideEffect: "mutation",
    disabled: sendBlocked || (!draft.trim() && attachments.length === 0) || model.transitionState !== "idle",
    targetRef: composerShellRef,
    execute: async () => {
      await handleSend();
      return true;
    },
  }), [attachments.length, draft, handleSend, model.transitionState, sendBlocked]);
  useControlAction(composerSendControlAction);

  const composerStopControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "composer.stop",
    label: t("control.stop_run"),
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
      toast.warning(nextError instanceof Error ? nextError.message : t("session.shared_folder_upload_failed"));
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

  const searchMessagePresent = Boolean(searchMessageId && renderedMessages.some(message => message.id === searchMessageId));
  useEffect(() => {
    if (!searchMessageId || searchMessagePresent) return;
    let cancelled = false;
    void snapshotQuery.refetch().then(result => {
      if (cancelled) return;
      if (result.error || !result.data?.messages.some(message => message.info.id === searchMessageId)) {
        toast.error(t("content_search.message_unavailable"));
        useSearchNavigation.getState().setTarget(null);
      }
    });
    return () => { cancelled = true; };
  }, [searchMessageId, searchMessagePresent, snapshotQuery.refetch]);
  useEffect(() => {
    if (!searchMessageId || !searchMessagePresent) return;
    const frame = requestAnimationFrame(() => {
      if (sessionScroll.jumpToMessage(searchMessageId)) useSearchNavigation.getState().setTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [searchMessageId, searchMessagePresent, sessionScroll.jumpToMessage]);

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
    label: t("control.go_top"),
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
    label: t("control.go_bottom"),
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
    label: t("control.read_latest_message"),
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
    label: t("control.read_transcript"),
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
    <div className="lw-session-typography flex h-full min-h-0 flex-col">
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
          aria-hidden={props.realtimeVoiceActive || undefined}
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
          className={cn(
            "lw-session-transcript absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 py-4 md:px-8",
            props.realtimeVoiceActive && "pointer-events-none",
          )}
        >
          <div ref={contentRef} className="lw-session-column">
            {pendingSessionLoad ? (showDelayedLoading ? (
              <div className="px-6 py-16">
                <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
                  <div className="text-sm text-dls-secondary">{t("session.opening")}</div>
                </div>
              </div>
            ) : null) : (snapshotQuery.isError || error) && !snapshot && renderedMessages.length === 0 ? (
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
                    {snapshotQuery.error instanceof Error ? snapshotQuery.error.message : t("session.load_failed")}
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
                      legalworkClient={props.client}
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
                        eigenweltPlan={eigenweltPlan}
                        renderUsageLimit={(error, messageId) => {
                          const provider = providerFromUsageLimitError(error);
                          const legacyBudget = isEigenweltBudgetExceededErrorText(error);
                          if (!isProviderUsageLimitError(error, props.selectedModel.providerID) && provider === null && !legacyBudget) return null;
                          return <ProviderLimitMessage
                            client={props.client}
                            workspaceId={props.workspaceId}
                            plan={eigenweltPlan}
                            providerId={provider || (legacyBudget ? "eigenwelt" : props.selectedModel.providerID)}
                            onChoosePlan={props.onChooseAiPlan}
                            resolved={messageId ? hasAssistantReplyAfter(renderedMessages, messageId) : false}
                          />;
                        }}
                        messages={renderedMessages}
                        status={status}
                        retryStatus={retryStatusForDisplay}
                      />
                      <RecordingDetailDialog />
                    </MessageListProvider>
                  </EnvironmentVariableProvider>
                </OpenTargetProvider>
              </DevProfiler>
            )}
          </div>
        </div>
        {props.realtimeVoiceActive && props.realtimeVoiceSupported ? (
          <VoicePanel
            client={props.client}
            workspaceId={props.workspaceId}
            sessionId={props.sessionId}
            sessionContext={transcriptToText(renderedMessages)}
            job={voiceJob}
            activity={voiceActivity}
            onStartJob={startVoiceJob}
            onClose={() => props.onRealtimeVoiceActiveChange?.(false)}
          />
        ) : (
          <SessionScrollOverlay
            sessionId={props.sessionId}
            isStreaming={chatStreaming}
            onJumpToLatest={sessionScroll.jumpToLatest}
            onJumpToStartOfMessage={sessionScroll.jumpToStartOfMessage}
          />
        )}
      </div>

      <div ref={composerShellRef} className={cn("shrink-0 px-0 pb-2 pt-2",
        !pendingSessionLoad && renderedMessages.length === 0 && "lw-fade-enter",
      )}>
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
        onStop={handleAbort}
        busy={chatStreaming}
        queuedCount={queuedDrafts.length}
        disabled={model.transitionState !== "idle" || sendBlocked}
        modelUnavailable={Boolean(props.modelUnavailable)}
        modelUnavailableLabelHidden={lockedOutNoticeVisible}
        statusLabel={statusLabel(snapshot ?? undefined, chatStreaming)}
        modelPickerOpen={props.modelPickerOpen}
        selectedModel={props.selectedModel}
        onModelPickerOpenChange={props.onModelPickerOpenChange}
        onModelChange={props.onModelChange}
        attachments={attachments}
        onAttachFiles={handleAttachFiles}
        uploading={pendingAttachmentUploads > 0}
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
        onDropLegalMemoryFile={handleDropLegalMemoryFile}
        onDropLegalMemoryFolder={handleDropLegalMemoryFolder}
        onDropStorageFile={handleDropStorageFile}
        onDropProjectFile={source => { try { if (!projectFiles) throw new Error(t("project_files.source_unavailable")); projectFiles.attach(source, props.sessionId); } catch (error) { toast.error(error instanceof Error ? error.message : t("project_files.failed")); } }}
        onDropWorkspaceFile={handleDropWorkspaceFile}
        inputHistory={inputHistory}
        onPasteText={handlePasteText}
        onUnsupportedFileLinks={handleUnsupportedFileLinks}
        pastedText={pasteParts}
        onExpandPastedText={handleExpandPastedText}
        onRemovePastedText={handleRemovePastedText}
        isRemoteWorkspace={props.isRemoteWorkspace}
          isSandboxWorkspace={props.isSandboxWorkspace}
          modelLocked={props.modelSelectorLocked}
          fusionEnabled={fusionEnabled}
          onToggleFusion={fusionAvailable ? handleToggleFusion : undefined}
          fusionModels={fusionAvailable ? fusionModels ?? [] : []}
          onFusionModelsChange={fusionAvailable ? handleFusionModelsChange : undefined}
          onToggleLiveTranscript={recorderActive ? handleToggleLiveTranscript : undefined}
          liveTranscriptActive={liveTranscriptActive}
          realtimeVoiceSupported={props.realtimeVoiceSupported}
          realtimeVoiceActive={props.realtimeVoiceActive}
          onToggleRealtimeVoice={() => props.onRealtimeVoiceActiveChange?.(!props.realtimeVoiceActive)}
          onUploadInboxFiles={props.onUploadInboxFiles ?? handleUploadInboxFiles}
          queueAccessory={queuePaused || queuedDrafts.length > 0 || editingQueuedDraftId ? (
            <QueuedMessagesPanel messages={queuedDrafts} onRemove={removeQueuedDraft} onEdit={editQueuedDraft} onReorder={reorderQueuedDrafts} editingId={editingQueuedDraftId} onCancelEdit={cancelQueuedEdit} paused={queuePaused} onResume={resumeQueue} disabled={sendBlocked || queueSaving} />
          ) : null}
          compactTopSpacing={Boolean(trialEndedNoticeVisible || connectNoticeVisible || props.activeQuestion || hasActivePlan || props.activePermission || queuedDrafts.length > 0)}
          topAccessory={
            trialEndedNoticeVisible || connectNoticeVisible || props.activeQuestion || hasActivePlan || props.activePermission ? (
              <div>
                {trialEndedNoticeVisible ? <TrialEndedNotice billingUrl={trialBillingUrl} /> : null}
                {connectNoticeVisible ? (
                  <NoModelNotice
                    variant={connectNoticeVariant}
                    onConnect={onConnectAi}
                    onPickModel={props.onModelClick}
                  />
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
                ) : null}
                {hasActivePlan ? (
                  <TodoPanel key={`${props.workspaceId}:${props.sessionId}`} todos={props.todos ?? []} />
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
