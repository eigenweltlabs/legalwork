import {invalidateNativeCatalogReady} from "@/app/lib/opencode-catalog-ready";
import { t } from "@/i18n";
import {
  projectSession,
  projectMessage,
  projectTool,
  toolDisplayText,
  type ToolPart,
} from "@/app/lib/opencode-view";
import { readMessages, readSession, projectNativeTodos } from "@/app/lib/opencode-read";
import { applyMarkdownStreamEvent } from "../artifacts/markdown-stream";
import { usePanelTabStore } from "../panel/panel-tab-store";
import type { UIMessage } from "ai";
import { scheduledTextMetadata } from "../../scheduled-tasks/scheduled-message";
import type { HostApprovalRequest } from "@legalwork/types/desktop-ipc";
import { textPartProviderMetadata } from "./assistant-message-sender";
import type {
  FilePart,
  Part,
  SessionView as Session,
  Todo,
} from "@/app/lib/opencode-view";
import type {
  SessionStatus,
  SessionMessageAssistantTool,
} from "@opencode/client";
import type { PendingQuestion as QuestionRequest } from "@/app/types";

import { getReactQueryClient } from "../../../infra/query-client";
import {
  analyticsSurface,
  captureAnalyticsEvent,
  isAnalyticsSending,
  takeTaskRunStart,
} from "@/app/lib/analytics";
import {
  analyticsErrorService,
  analyticsErrorStatus,
} from "@/app/lib/analytics-error";
import {
  allowlistedErrorName,
  sessionErrorFingerprint,
} from "@/app/lib/app-error";
import {
  createClient,
  resolveLegalworkWorkspaceMount,
  unwrap,
} from "@/app/lib/opencode";
import { abortSessionSafe } from "@/app/lib/opencode-session";
import {
  eigenweltUsageLimitFromError,
  isAnthropicUsageLimitError,
  isProviderUsageLimitError,
  providerUsageLimitErrorText,
  usageLimitRetryEvent,
} from "@/app/lib/provider-usage-limit";
import { useComposerStateStore } from "../surface/composer-state-store";
import { normalizeEvent } from "@/app/utils";
import {
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
  type Client,
  type OpencodeEvent,
  type PendingPermission,
  type PendingQuestion,
} from "@/app/types";
import {
  consumeProviderUsageLimitStop,
  markEigenweltBudgetStop,
  updateProviderUsageLimitStop,
} from "@/app/lib/eigenwelt-budget";
import {
  createSessionErrorUIMessage,
  describeOpencodeSessionError,
  isSessionAbortError,
  snapshotToUIMessages,
} from "./usechat-adapter";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";
import {
  createLegalworkServerClient,
  type LegalworkSessionSnapshot,
} from "@/app/lib/legalwork-server";
import {
  applyRevertCursor,
  reconcileTranscriptMessages,
} from "./transcript-reconcile";
import { useSessionActivityStore } from "../status/session-activity-store";

import {
  permissionKey,
  questionKey,
  permissionWithReceivedAt,
  questionWithReceivedAt,
  sortInteractionRequests,
  seedInteractionSession,
  removeInteractionSession,
  resolveInteractionLineage,
  refreshWorkspaceInteractions,
  createInteractionSnapshot,
  interactionRequestKey,
  interactionSessionIds,
  interactionSessionsKey,
  type InteractionSessions,
  type InteractionSnapshot,
} from "./interaction-state";
export {
  permissionKey,
  questionKey,
  seedPermissionState,
  seedQuestionState,
} from "./interaction-state";

type SyncOptions = {
  workspaceId: string;
  baseUrl: string;
  legalworkToken: string;
  onSessionUpdated?: (update: {
    sessionId: string;
    info: Record<string, unknown>;
  }) => void;
  onSessionStatus?: (update: {
    sessionId: string;
    status: SessionStatus;
  }) => void;
};

type PendingDelta = {
  sessionId: string;
  messageId: string;
  partId: string;
  reasoning: boolean;
  delta: string;
};

type SyncEntry = {
  input: SyncOptions;
  client: Client | null;
  interactionSnapshot: InteractionSnapshot | null;
  resolvingLineages: Map<string, Promise<void>>;
  deletedSessionIds: Set<string>;
  refs: number;
  dispose: () => void;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  trackedSessionRefs: Map<string, number>;
  retainedSessionTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessionUpdatedListeners: Set<NonNullable<SyncOptions["onSessionUpdated"]>>;
  sessionStatusListeners: Set<NonNullable<SyncOptions["onSessionStatus"]>>;
  toolParts: Map<string, ToolPart>;
  pendingDeltas: Map<
    string,
    { messageId: string; reasoning: boolean; text: string }
  >;
  // Coalesce rapid-fire delta events from the SSE stream into one cache
  // commit per animation frame. Without this, a long response produces a
  // setQueryData per token; each triggers a full transcript re-render
  // (~27ms on large sessions) which starves the main thread and looks to
  // the user like the app "freezes after 2 words."
  deltaFlushBuffer: PendingDelta[];
  deltaFlushScheduled: boolean;
};

const usageLimitStops = new Set<string>();

const idleStatus: SessionStatus = { type: "idle" };
const syncs = new Map<string, SyncEntry>();
const retainedSessionTtlMs = 10 * 60_000;
const idleRetainedSessionTtlMs = 10_000;

export const snapshotKey = (workspaceId: string, sessionId: string) =>
  ["react-session-snapshot", workspaceId, sessionId] as const;
export const transcriptKey = (workspaceId: string, sessionId: string) =>
  ["react-session-transcript", workspaceId, sessionId] as const;
export const statusKey = (workspaceId: string, sessionId: string) =>
  ["react-session-status", workspaceId, sessionId] as const;
export const todoKey = (workspaceId: string, sessionId: string) =>
  ["react-session-todos", workspaceId, sessionId] as const;

function syncKey(input: SyncOptions) {
  return `${input.workspaceId}:${input.baseUrl}:${input.legalworkToken}`;
}

function getErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    status?: unknown;
    response?: { status?: unknown };
    cause?: { status?: unknown };
  };
  const status =
    record.status ?? record.response?.status ?? record.cause?.status;
  return typeof status === "number" ? status : null;
}

/** Bump when the shape or meaning of `RunStats` changes, so analysis can tell
 * eras apart instead of averaging them. v1 measured only the run's final
 * assistant message and is off by ~100x on input; discard it rather than
 * chart it next to v2. */
const RUN_STATS_VERSION = 2;

/** The engine's five token buckets do not overlap — `input` excludes cache
 * reads, `output` excludes reasoning — and providers bill each at its own
 * rate, so a cost estimate needs the whole set, not just input/output. */
type RunStats = {
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number;
  tool_call_count: number;
  turn_count: number;
  message_count: number;
};

/** The engine is an external process: its payloads are typed but not
 * guaranteed, and analytics must never throw inside the idle handler. */
const finiteOrZero = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Per-run stats straight from opencode's own data on the completed run: token
 * totals, cost and part counts summed over every assistant message the run
 * produced, which is one message per engine step.
 *
 * The run is delimited by the latest user message rather than by
 * `markTaskRunStart`'s wall clock, so skew between the app and the engine
 * cannot slice a turn in half. A session with no user message at all (a
 * shell-only run) has no earlier turn to absorb, so summing from the top is
 * still this run.
 *
 * Content-free (numbers only).
 */
function runStatsFromSnapshot(
  snapshot: LegalworkSessionSnapshot | undefined,
): RunStats | null {
  const messages = snapshot?.messages ?? [];
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info.role === "user") {
      start = index + 1;
      break;
    }
  }

  const stats: RunStats = {
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost_usd: 0,
    tool_call_count: 0,
    turn_count: 0,
    message_count: 0,
  };

  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.info.role !== "assistant") continue;
    stats.message_count += 1;
    stats.turn_count += 1;
    const { cost, tokens } = message.info;
    stats.tokens_input += finiteOrZero(tokens?.input);
    stats.tokens_output += finiteOrZero(tokens?.output);
    stats.tokens_reasoning += finiteOrZero(tokens?.reasoning);
    stats.tokens_cache_read += finiteOrZero(tokens?.cache?.read);
    stats.tokens_cache_write += finiteOrZero(tokens?.cache?.write);
    stats.cost_usd += finiteOrZero(cost);
    for (const part of message.parts) {
      if (part.type === "tool") stats.tool_call_count += 1;
    }
  }

  if (stats.message_count === 0) return null;
  // Float noise across many per-message costs; a run never bills to less than
  // a millionth of a cent, so round rather than ship 0.30000000000000004.
  stats.cost_usd = Math.round(stats.cost_usd * 1e8) / 1e8;
  return stats;
}

export const __runStatsFromSnapshotForTest = runStatsFromSnapshot;
export const __RUN_STATS_VERSION_FOR_TEST = RUN_STATS_VERSION;

/**
 * Emit a run-terminal event with the run's token stats attached.
 *
 * Refreshing the snapshot first is what makes the stats cover the run rather
 * than whatever the cache held when the run ended; it is skipped when nothing
 * would be sent (the inspector mirror then uses the cached snapshot). Detached
 * on purpose: the caller's UI work must not wait on a round-trip, and an
 * errored run in particular has a transcript message to render first.
 *
 * A run that failed or was stopped still billed for every call it made before
 * it ended, so all three outcomes carry the same stats — leaving them off
 * understated spend by however much work the run did before dying.
 */
export function captureRunOutcome(
  workspaceId: string,
  sessionId: string,
  event: "task_run_completed" | "task_run_errored" | "task_run_stopped",
  properties: Record<string, unknown>,
  options: { refresh?: boolean } = {},
) {
  const queryClient = getReactQueryClient();
  void (async () => {
    // `refresh: false` is for a caller that just awaited its own refetch of
    // this same key (the stop button), so the run is accounted once without
    // paying for a second round-trip.
    if (options.refresh !== false && isAnalyticsSending()) {
      try {
        await queryClient.refetchQueries({
          queryKey: snapshotKey(workspaceId, sessionId),
          exact: true,
        });
      } catch {
        // Best-effort: fall back to whatever is cached.
      }
    }
    const snapshot = queryClient.getQueryData<LegalworkSessionSnapshot>(
      snapshotKey(workspaceId, sessionId),
    );
    captureAnalyticsEvent(event, {
      session_id: sessionId,
      surface: analyticsSurface(),
      // Tags the event even when no stats resolved, so v1's undercounted rows
      // stay separable from v2's in analysis.
      stats_version: RUN_STATS_VERSION,
      ...properties,
      ...(runStatsFromSnapshot(snapshot) ?? {}),
    });
  })();
}

function shouldRetrySyncSubscribe(error: unknown) {
  const status = getErrorStatus(error);
  return status !== 401 && status !== 403 && status !== 404;
}

function isTrackedSession(entry: SyncEntry, sessionId: string) {
  return (
    (entry.trackedSessionRefs.get(sessionId) ?? 0) > 0 ||
    entry.retainedSessionTimers.has(sessionId)
  );
}

function isLiveStatus(status: SessionStatus | null | undefined) {
  return status?.type === "busy" || status?.type === "retry";
}

function messageHasVisibleAssistantOutput(message: UIMessage) {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string")
      return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

function assistantOutputAfterLatestUser(messages: UIMessage[]) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return messages
    .slice(lastUserIndex + 1)
    .some(messageHasVisibleAssistantOutput);
}

function sessionIdFromProperties(properties: unknown) {
  if (!properties || typeof properties !== "object") return "";
  const sessionID = (properties as { sessionID?: unknown }).sessionID;
  return typeof sessionID === "string" ? sessionID : "";
}

function sessionErrorFromProperties(properties: unknown) {
  if (!properties || typeof properties !== "object") return undefined;
  return (properties as { error?: unknown }).error;
}

function latestAssistantMessageId(messages: UIMessage[]) {
  // The snapshot keys each error to its errored assistant message id, so the
  // live event must resolve to that same id to dedupe on reload. Skipping
  // synthetic error messages ensures a follow-up error keys off the real
  // assistant turn rather than overwriting the previous error message.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)) continue;
    return message.id;
  }
  return null;
}

function partHasVisibleAssistantOutput(part: Part) {
  if (part.type === "text" && part.synthetic) return false;
  if (part.type === "text" && part.ignored) return false;
  const partType = String(part.type);
  if (
    "text" in part &&
    typeof part.text === "string" &&
    part.text.trim().length > 0
  )
    return true;
  return partType === "tool" || partType === "file" || partType === "agent";
}

function clearTrackedSession(
  input: SyncOptions,
  entry: SyncEntry,
  sessionId: string,
) {
  entry.trackedSessionRefs.delete(sessionId);
  const retainedTimer = entry.retainedSessionTimers.get(sessionId);
  if (retainedTimer) clearTimeout(retainedTimer);
  entry.retainedSessionTimers.delete(sessionId);
  entry.deltaFlushBuffer = entry.deltaFlushBuffer.filter(
    (item) => item.sessionId !== sessionId,
  );
  // Transcript retention must not discard an unresolved approval.
  if (entry.refs <= 0 && entry.retainedSessionTimers.size === 0) {
    disposeWorkspaceSync(syncKey(input), entry);
  }
}

function retainSession(
  input: SyncOptions,
  entry: SyncEntry,
  sessionId: string,
  ttlMs = retainedSessionTtlMs,
) {
  const existing = entry.retainedSessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  entry.retainedSessionTimers.set(
    sessionId,
    setTimeout(() => {
      clearTrackedSession(input, entry, sessionId);
    }, ttlMs),
  );
}

function disposeWorkspaceSync(key: string, entry: SyncEntry) {
  if (entry.refs > 0) return;
  if (entry.disposeTimer) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
  for (const timer of entry.retainedSessionTimers.values()) clearTimeout(timer);
  entry.retainedSessionTimers.clear();
  for (const key of usageLimitStops) {
    if (key.startsWith(`${entry.input.workspaceId}:`))
      usageLimitStops.delete(key);
  }
  entry.dispose();
  if (syncs.get(key) === entry) syncs.delete(key);
}

function releaseRetainedSessionSoon(
  input: SyncOptions,
  entry: SyncEntry,
  sessionId: string,
) {
  if (!entry.retainedSessionTimers.has(sessionId)) return;
  retainSession(input, entry, sessionId, idleRetainedSessionTtlMs);
}

/** Host approvals share the chat's permission queue and waiting indicator. */
export function seedHostApprovalState(
  workspaceId: string,
  requests: HostApprovalRequest[],
  runtime?: { workspaceId: string; baseUrl: string },
) {
  const queryClient = getReactQueryClient();
  const sessions = new Set(
    requests.flatMap((request) =>
      request.sessionID ? [request.sessionID] : [],
    ),
  );
  for (const [key] of queryClient.getQueriesData({
    queryKey: ["react-session-permissions", workspaceId],
  })) {
    if (typeof key[2] === "string") sessions.add(key[2]);
  }
  for (const sessionID of sessions) {
    const key = permissionKey(workspaceId, sessionID);
    const current = queryClient.getQueryData<PendingPermission[]>(key) ?? [];
    const next: PendingPermission[] = requests.flatMap((request) =>
      request.sessionID === sessionID
        ? [
            {
              id: `host:${request.id}`,
              sessionID,
              permission: request.action.replace(/^sandbox\./, ""),
              patterns: request.paths,
              metadata: {
                description: request.description,
                summary: request.summary,
              },
              always: [],
              receivedAt: request.createdAt,
              protocol: "host",
              host: request,
            },
          ]
        : [],
    );
    const activity = useSessionActivityStore.getState();
    for (const item of current.filter((item) => item.protocol === "host"))
      activity.setWaitingRequest(
        runtime?.workspaceId ?? workspaceId,
        sessionID,
        "permission",
        item.id,
        false,
      );
    for (const item of next)
      activity.setWaitingRequest(
        runtime?.workspaceId ?? workspaceId,
        sessionID,
        "permission",
        item.id,
        true,
      );
    queryClient.setQueryData(
      key,
      [...current.filter((item) => item.protocol !== "host"), ...next].sort(
        sortInteractionRequests,
      ),
    );
    if (next.length)
      for (const entry of syncs.values()) {
        if (
          entry.input.workspaceId === (runtime?.workspaceId ?? workspaceId) &&
          (!runtime || entry.input.baseUrl === runtime.baseUrl) &&
          !entry.deletedSessionIds.has(sessionID)
        )
          resolveRequestLineage(entry, sessionID);
      }
  }
}
function fileProviderMetadata(part: FilePart) {
  return {opencode:{partId:part.id,...(part.source ? {source:part.source}:{}),...(part.history ? {historicalAttachment:part.history}:{})}};
}

function toFileUIPart(part: FilePart): UIMessage["parts"][number] {
  return {
    type: "file",
    url: part.url,
    filename: part.filename,
    mediaType: part.mime,
    providerMetadata: fileProviderMetadata(part),
  };
}

function toFileSourceUIPart(part: FilePart): UIMessage["parts"][number] | null {
  const source = part.source;
  if (!source) return null;

  const sourceId = `${part.id}:source`;
  const providerMetadata = {
    opencode: { partId: sourceId, sourcePartId: part.id, source },
  };

  if (source.type === "resource") {
    if (source.uri.startsWith("http://")) {
      return {
        type: "source-url",
        sourceId,
        url: source.uri,
        title: source.uri,
        providerMetadata,
      };
    }
    if (source.uri.startsWith("https://")) {
      return {
        type: "source-url",
        sourceId,
        url: source.uri,
        title: source.uri,
        providerMetadata,
      };
    }
    return {
      type: "source-document",
      sourceId,
      mediaType: part.mime,
      title: source.uri,
      providerMetadata,
    };
  }

  if (source.type === "symbol") {
    return {
      type: "source-document",
      sourceId,
      mediaType: part.mime,
      title: source.name,
      filename: source.path,
      providerMetadata,
    };
  }

  return {
    type: "source-document",
    sourceId,
    mediaType: part.mime,
    title: source.path,
    filename: source.path,
    providerMetadata,
  };
}

function toFileUIParts(part: FilePart): UIMessage["parts"] {
  const sourcePart = toFileSourceUIPart(part);
  if (sourcePart) return [toFileUIPart(part), sourcePart];
  return [toFileUIPart(part)];
}

function toUIPart(part: Part): UIMessage["parts"][number] | null {
  if (part.type === "text") {
    if (part.synthetic || part.ignored) return null;
    return {
      type: "text",
      text: part.text,
      state: "done",
      providerMetadata: { opencode: { ...scheduledTextMetadata(part).opencode, ...textPartProviderMetadata(part).opencode } },
    };
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text,
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "file") {
    return toFileUIPart(part);
  }
  if (part.type === "tool") {
    if (part.tool === STRUCTURED_OUTPUT_TOOL) {
      return parseStructuredOutputUIPart(part);
    }
    return parseDynamicToolUIPart(part);
  }
  if (part.type === "agent") {
    return {
      type: "text",
      text: part.name ? `@${part.name}` : "@agent",
      state: "done",
      providerMetadata: { opencode: { partId: part.id } },
    };
  }
  if (part.type === "step-start") return { type: "step-start" };
  return null;
}

function toUIParts(part: Part): UIMessage["parts"] {
  if (part.type === "file") return toFileUIParts(part);
  const mapped = toUIPart(part);
  if (!mapped) return [];
  if (part.type === "tool" && part.tool === STRUCTURED_OUTPUT_TOOL)
    return [mapped];
  if (
    part.type === "tool" &&
    part.state.status === "completed" &&
    part.state.attachments
  ) {
    return [mapped, ...part.state.attachments.flatMap(toFileUIParts)];
  }
  return [mapped];
}

function getPartMetadataId(part: UIMessage["parts"][number]) {
  if (part.type === "dynamic-tool") {
    const metadata = part.callProviderMetadata?.opencode;
    if (!metadata || typeof metadata !== "object") return null;
    return "partId" in metadata
      ? ((metadata as { partId?: string }).partId ?? null)
      : null;
  }
  if (
    part.type !== "text" &&
    part.type !== "reasoning" &&
    part.type !== "file" &&
    part.type !== "source-url" &&
    part.type !== "source-document"
  )
    return null;
  const metadata = part.providerMetadata?.opencode;
  if (!metadata || typeof metadata !== "object") return null;
  return "partId" in metadata
    ? ((metadata as { partId?: string }).partId ?? null)
    : null;
}

function upsertMessage(messages: UIMessage[], next: UIMessage) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  return messages.map((message, messageIndex) =>
    messageIndex === index
      ? {
          ...message,
          ...next,
          parts: next.parts.length > 0 ? next.parts : message.parts,
        }
      : message,
  );
}

/**
 * When a message.part.updated or message.part.delta event arrives for a
 * messageID we haven't seen a message.updated for yet, we have to stub the
 * message so the part has somewhere to live. The stub's role used to be
 * hard-coded to "assistant", which meant that if part events beat the
 * message.updated event for a *user* turn (a common race during
 * promptAsync), that user message flashed as an assistant-styled block
 * until the real role arrived a tick later.
 *
 * Infer the stub role from the conversation instead. Chat sessions
 * alternate, so the new message is almost always the opposite role of the
 * most recent known message. If the transcript is empty the first message
 * is always the user's.
 */
function inferStubRole(messages: UIMessage[]): UIMessage["role"] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return "user";
  if (lastMessage.role === "user") return "assistant";
  if (lastMessage.role === "assistant") return "user";
  return "assistant";
}

function upsertPart(
  messages: UIMessage[],
  messageId: string,
  partId: string,
  next: UIMessage["parts"][number],
) {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const index = message.parts.findIndex(
      (part) =>
        ("toolCallId" in part && part.toolCallId === partId) ||
        getPartMetadataId(part) === partId,
    );
    if (index === -1) {
      return { ...message, parts: [...message.parts, next] };
    }
    const parts = message.parts.slice();
    parts[index] = next;
    return { ...message, parts };
  });
}

function appendDelta(
  messages: UIMessage[],
  messageId: string,
  partId: string,
  delta: string,
  reasoning: boolean,
) {
  // Fast path: locate the target message by index, only clone that message
  // and its parts array. The previous implementation ran messages.map AND
  // message.parts.map on every delta event, which is O(N * P) per token.
  // For an old session with hundreds of prior messages/parts that allocated
  // thousands of objects per token and crushed the main thread after a
  // handful of tokens.
  const messageIndex = messages.findIndex(
    (message) => message.id === messageId,
  );
  if (messageIndex === -1) return messages;

  const target = messages[messageIndex]!;
  const lastPart = target.parts[target.parts.length - 1];

  let partIndex = -1;
  for (let i = 0; i < target.parts.length; i++) {
    const part = target.parts[i]!;
    const id = getPartMetadataId(part);
    if (reasoning && part.type === "reasoning") {
      if (id === partId || (!id && part === lastPart)) {
        partIndex = i;
        break;
      }
    } else if (!reasoning && part.type === "text") {
      if (id === partId || (!id && part === lastPart)) {
        partIndex = i;
        break;
      }
    }
  }

  let nextParts: UIMessage["parts"];
  if (partIndex === -1) {
    // No existing matching part — append a fresh one so the delta is not lost.
    const newPart: UIMessage["parts"][number] = reasoning
      ? {
          type: "reasoning",
          text: delta,
          state: "streaming" as const,
          providerMetadata: { opencode: { partId } },
        }
      : {
          type: "text",
          text: delta,
          state: "streaming" as const,
          providerMetadata: { opencode: { partId } },
        };
    nextParts = target.parts.slice();
    nextParts.push(newPart);
  } else {
    const existing = target.parts[partIndex]!;
    nextParts = target.parts.slice();
    if (existing.type === "text") {
      nextParts[partIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        state: "streaming",
      };
    } else if (existing.type === "reasoning") {
      nextParts[partIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        state: "streaming",
      };
    }
  }

  const nextMessages = messages.slice();
  nextMessages[messageIndex] = { ...target, parts: nextParts };
  return nextMessages;
}

export function coalescePendingDeltas(items: PendingDelta[]) {
  if (items.length < 2) return items;

  const ordered: PendingDelta[] = [];
  const byKey = new Map<string, PendingDelta>();
  for (const item of items) {
    const key = `${item.sessionId}\u0000${item.messageId}\u0000${item.partId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.delta += item.delta;
      existing.reasoning = existing.reasoning || item.reasoning;
      continue;
    }

    const next = { ...item };
    byKey.set(key, next);
    ordered.push(next);
  }
  return ordered;
}

async function stopUsageLimitRetry(
  entry: SyncEntry,
  workspaceId: string,
  sessionId: string,
  error: unknown,
) {
  const key = `${workspaceId}:${sessionId}`;
  if (usageLimitStops.has(key)) return;
  const queryClient = getReactQueryClient();
  const snapshot = queryClient.getQueryData<LegalworkSessionSnapshot>(
    snapshotKey(workspaceId, sessionId),
  );
  const client = createClient(entry.input.baseUrl, undefined, {
    token: entry.input.legalworkToken,
    mode: "legalwork",
  });
  let ownsStop = false;
  try {
    const session = snapshot?.session ?? (await readSession(client, sessionId));
    // Legacy retry status only contains prose. Resolve the current turn before
    // classifying it so Claude never falls through to another provider's regex.
    const currentMessages = await readMessages(client, sessionId);
    const currentInfo = currentMessages.at(-1)?.info;
    const currentProvider =
      currentInfo?.role === "assistant"
        ? currentInfo.providerID
        : currentInfo?.model.providerID || session.model?.providerID;
    if (
      !isProviderUsageLimitError(error, currentProvider) ||
      usageLimitStops.has(key)
    )
      return;
    usageLimitStops.add(key);
    ownsStop = true;
    useComposerStateStore.getState().setQueuePaused(sessionId, true);
    const limit =
      currentProvider === "eigenwelt"
        ? eigenweltUsageLimitFromError(error)
        : null;
    const pendingText = providerUsageLimitErrorText(
      currentProvider ?? "",
      limit,
    );
    injectSessionErrorMessage(workspaceId, sessionId, pendingText);
    markEigenweltBudgetStop(sessionId, Date.now(), pendingText);
    const stopped = await abortSessionSafe(
      client,
      sessionId,
      session.directory,
    );
    if (!stopped) usageLimitStops.delete(key);
    // A cached snapshot can predate this run's newly created assistant turn.
    const messages = await readMessages(client, sessionId);
    const info = messages.at(-1)?.info;
    const providerId =
      info?.role === "assistant"
        ? info.providerID
        : info?.model.providerID || session.model?.providerID || "";
    const errorText = providerUsageLimitErrorText(providerId, limit);
    updateProviderUsageLimitStop(sessionId, errorText);
    injectSessionErrorMessage(workspaceId, sessionId, errorText);
    const mount = resolveLegalworkWorkspaceMount(entry.input.baseUrl);
    if (stopped && mount && info?.role === "assistant") {
      const server = createLegalworkServerClient({
        baseUrl: mount.baseUrl,
        token: entry.input.legalworkToken,
      });
      await server.recordSessionUsageLimit(
        mount.workspaceId,
        sessionId,
        info.id,
        limit,
      );
    }
  } catch {
    if (ownsStop) usageLimitStops.delete(key);
  }
}

function resolveRequestLineage(entry: SyncEntry, sessionId: string) {
  if (!entry.client || entry.resolvingLineages.has(sessionId)) return;
  const recovery = resolveInteractionLineage(
    {
      client: entry.client,
      workspaceId: entry.input.workspaceId,
      isCurrent: (id) =>
        syncs.get(syncKey(entry.input)) === entry &&
        (!id || !entry.deletedSessionIds.has(id)),
      onSessionUpdated: (update) => {
        for (const listener of entry.sessionUpdatedListeners) listener(update);
      },
    },
    sessionId,
  )
    .catch(() => {
      // The request remains queued; reconnect recovery can resolve its lineage.
    })
    .finally(() => entry.resolvingLineages.delete(sessionId));
  entry.resolvingLineages.set(sessionId, recovery);
}

export function acknowledgeInteraction(
  workspaceId: string,
  sessionId: string,
  requestId: string,
  kind: "permission" | "question",
) {
  for (const entry of syncs.values()) {
    if (entry.input.workspaceId !== workspaceId) continue;
    const changes =
      kind === "permission"
        ? entry.interactionSnapshot?.permissions
        : entry.interactionSnapshot?.questions;
    changes?.set(interactionRequestKey(sessionId, requestId), false);
  }
  const queryClient = getReactQueryClient();
  if (kind === "permission") {
    queryClient.setQueryData<PendingPermission[]>(
      permissionKey(workspaceId, sessionId),
      (current = []) => current.filter((item) => item.id !== requestId),
    );
  } else {
    queryClient.setQueryData<PendingQuestion[]>(
      questionKey(workspaceId, sessionId),
      (current = []) => current.filter((item) => item.id !== requestId),
    );
  }
  useSessionActivityStore
    .getState()
    .setWaitingRequest(workspaceId, sessionId, kind, requestId, false);
}

function applyEvent(
  entry: SyncEntry,
  workspaceId: string,
  event: OpencodeEvent,
) {
  applyMarkdownStreamEvent(workspaceId, event);
  const cache = getReactQueryClient();
  const data = event.data;
  const sessionId =
    "sessionID" in data && typeof data.sessionID === "string"
      ? data.sessionID
      : "";
  if (sessionId && entry.deletedSessionIds.has(sessionId)) return;
  const refreshSnapshot = (id: string) => {
    if (isTrackedSession(entry, id))
      void cache.invalidateQueries({
        queryKey: snapshotKey(workspaceId, id),
        exact: true,
      });
  };
  const publishSession = async (id: string) => {
    if (!entry.client) return;
    try {
      const session = await readSession(entry.client, id);
      if (entry.deletedSessionIds.has(id)) return;
      seedInteractionSession(workspaceId, session);
      for (const listener of entry.sessionUpdatedListeners)
        listener({ sessionId: id, info: session });
      cache.setQueryData<LegalworkSessionSnapshot>(
        snapshotKey(workspaceId, id),
        (current) => (current ? { ...current, session } : current),
      );
    } catch {
      refreshSnapshot(id);
    }
  };
  const publishMessage = async (id: string, messageID: string) => {
    if (!entry.client || !isTrackedSession(entry, id)) return;
    try {
      const native = await entry.client.session.message.get({
        sessionID: id,
        messageID,
      });
      if (entry.deletedSessionIds.has(id)) return;
      const view = projectMessage(id, native);
      cache.setQueryData<LegalworkSessionSnapshot>(
        snapshotKey(workspaceId, id),
        (current) =>
          current
            ? {
                ...current,
                messages: [
                  ...current.messages.filter(
                    (message) => message.info.id !== messageID,
                  ),
                  ...view,
                ].sort((a, b) => a.info.time.created - b.info.time.created),
              }
            : current,
      );
      const snapshot = cache.getQueryData<LegalworkSessionSnapshot>(
        snapshotKey(workspaceId, id),
      );
      if (snapshot) seedSessionState(workspaceId, snapshot);
    } catch {
      refreshSnapshot(id);
    }
  };
  const setStatus = (status: SessionStatus) => {
    useSessionActivityStore
      .getState()
      .setRunStatus(workspaceId, sessionId, status);
    if (isTrackedSession(entry, sessionId))
      cache.setQueryData(statusKey(workspaceId, sessionId), status);
    for (const listener of entry.sessionStatusListeners)
      listener({ sessionId, status });
  };
  if(["server.connected","model.updated","provider.updated","integration.updated","credential.updated","credential.switched","models-dev.refreshed","config.updated"].includes(event.type))invalidateNativeCatalogReady();
  switch (event.type) {
    case "session.renamed": {
      cache.setQueryData<LegalworkSessionSnapshot>(snapshotKey(workspaceId,sessionId),current=>current ? {...current,session:{...current.session,title:event.data.title,time:{...current.session.time,updated:event.created}}}:current);
      for(const listener of entry.sessionUpdatedListeners)listener({sessionId,info:{title:event.data.title,time:{updated:event.created}}});
      void publishSession(sessionId);return;
    }
    case "session.created":
    case "session.metadata.updated":
    case "session.model.selected":
    case "session.agent.selected":
    case "session.archived":
    case "session.unarchived":
    case "session.moved":
    case "session.revert.staged":
    case "session.revert.cleared":
    case "session.revert.committed":
      void publishSession(sessionId);
      refreshSnapshot(sessionId);
      return;
    case "session.deleted":
      const sessions =
        cache.getQueryData<InteractionSessions>(
          interactionSessionsKey(workspaceId),
        ) ?? {};
      for (const id of interactionSessionIds(sessionId, sessions)) {
        entry.deletedSessionIds.add(id);
        entry.interactionSnapshot?.deletedSessions.add(id);
        usePanelTabStore.getState().clearSession(id);
        usageLimitStops.delete(`${workspaceId}:${id}`);
      }
      removeInteractionSession(workspaceId, sessionId);
      cache.removeQueries({ queryKey: snapshotKey(workspaceId, sessionId) });
      cache.removeQueries({ queryKey: transcriptKey(workspaceId, sessionId) });
      return;
    case "permission.asked": {
      const request = permissionWithReceivedAt(event.data, Date.now());
      resolveRequestLineage(entry, request.sessionID);
      entry.interactionSnapshot?.permissions.set(
        interactionRequestKey(request.sessionID, request.id),
        true,
      );
      cache.setQueryData<PendingPermission[]>(
        permissionKey(workspaceId, request.sessionID),
        (current = []) =>
          [...current.filter((item) => item.id !== request.id), request].sort(
            sortInteractionRequests,
          ),
      );
      useSessionActivityStore
        .getState()
        .setWaitingRequest(
          workspaceId,
          request.sessionID,
          "permission",
          request.id,
          true,
        );
      return;
    }
    case "permission.replied":
      acknowledgeInteraction(
        workspaceId,
        sessionId,
        event.data.requestID,
        "permission",
      );
      return;
    case "form.created": {
      const request = questionWithReceivedAt(event.data.form, Date.now());
      resolveRequestLineage(entry, request.sessionID);
      entry.interactionSnapshot?.questions.set(
        interactionRequestKey(request.sessionID, request.id),
        true,
      );
      cache.setQueryData<PendingQuestion[]>(
        questionKey(workspaceId, request.sessionID),
        (current = []) =>
          [...current.filter((item) => item.id !== request.id), request].sort(
            sortInteractionRequests,
          ),
      );
      useSessionActivityStore
        .getState()
        .setWaitingRequest(
          workspaceId,
          request.sessionID,
          "question",
          request.id,
          true,
        );
      return;
    }
    case "form.replied":
    case "form.cancelled":
      acknowledgeInteraction(workspaceId, sessionId, event.data.id, "question");
      return;
    case "session.status":
      if (event.data.status.type === "busy")
        usageLimitStops.delete(`${workspaceId}:${sessionId}`);
      setStatus(event.data.status);
      if (event.data.status.type === "retry")
        void stopUsageLimitRetry(
          entry,
          workspaceId,
          sessionId,
          event.data.status,
        );
      return;
    case "session.execution.started":
      usageLimitStops.delete(`${workspaceId}:${sessionId}`);
      setStatus({ type: "busy" });
      return;
    case "session.retry.scheduled":
      setStatus({
        type: "retry",
        attempt: event.data.attempt,
        next: event.data.at,
        message: event.data.error.message,
      });
      void stopUsageLimitRetry(entry, workspaceId, sessionId, event.data.error);
      return;
    case "session.step.started": {
      if (!isTrackedSession(entry, sessionId)) return;
      const message = {
        id: event.data.assistantMessageID,
        role: "assistant" as const,
        parts: [],
      };
      useSessionActivityStore
        .getState()
        .markMessageRole(
          workspaceId,
          sessionId,
          event.data.assistantMessageID,
          "assistant",
        );
      cache.setQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
        (current = []) => upsertMessage(current, message),
      );
      return;
    }
    case "session.text.started":
    case "session.reasoning.started": {
      if (!isTrackedSession(entry, sessionId)) return;
      const id = `${event.data.assistantMessageID}:content:${event.data.ordinal}`;
      const type =
        event.type === "session.reasoning.started" ? "reasoning" : "text";
      cache.setQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
        (current = []) =>
          upsertPart(
            upsertMessage(current, {
              id: event.data.assistantMessageID,
              role: "assistant",
              parts:
                current.find(
                  (message) => message.id === event.data.assistantMessageID,
                )?.parts ?? [],
            }),
            event.data.assistantMessageID,
            id,
            {
              type,
              text: "",
              state: "streaming",
              providerMetadata: { opencode: { partId: id } },
            },
          ),
      );
      return;
    }
    case "session.text.delta":
    case "session.reasoning.delta":
      if (!isTrackedSession(entry, sessionId)) return;
      useSessionActivityStore
        .getState()
        .markAssistantOutput(
          workspaceId,
          sessionId,
          event.data.assistantMessageID,
          { allowUnknownMessageRole: true },
        );
      entry.deltaFlushBuffer.push({
        sessionId,
        messageId: event.data.assistantMessageID,
        partId: `${event.data.assistantMessageID}:content:${event.data.ordinal}`,
        reasoning: event.type === "session.reasoning.delta",
        delta: event.data.delta,
      });
      scheduleDeltaFlush(entry, workspaceId);
      return;
    case "session.text.ended":
    case "session.reasoning.ended": {
      if (!isTrackedSession(entry, sessionId)) return;
      flushDeltas(entry, workspaceId);
      const id = `${event.data.assistantMessageID}:content:${event.data.ordinal}`;
      cache.setQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
        (current = []) =>
          upsertPart(current, event.data.assistantMessageID, id, {
            type:
              event.type === "session.reasoning.ended" ? "reasoning" : "text",
            text: event.data.text,
            state: "done",
            providerMetadata: { opencode: { partId: id, textComplete: true } },
          }),
      );
      return;
    }
    case "session.tool.input.started":
    case "session.tool.input.delta":
    case "session.tool.input.ended":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      if (!isTrackedSession(entry, sessionId)) return;
      const key = `${sessionId}:${event.data.assistantMessageID}:${event.data.id}`;
      let part = entry.toolParts.get(key);
      if (event.type === "session.tool.input.started")
        part = {
          id: event.data.id,
          sessionID: sessionId,
          messageID: event.data.assistantMessageID,
          type: "tool",
          callID: event.data.id,
          tool: event.data.name,
          state: { status: "pending", raw: "", input: {} },
        };
      if (!part) {
        void publishMessage(sessionId, event.data.assistantMessageID);
        return;
      }
      if (
        event.type === "session.tool.input.delta" &&
        part.state.status === "pending"
      )
        part = {
          ...part,
          state: { ...part.state, raw: part.state.raw + event.data.delta },
        };
      if (event.type === "session.tool.called")
        part = {
          ...part,
          state: {
            status: "running",
            input: event.data.input,
            time: { start: event.created },
          },
        };
      if (
        event.type === "session.tool.progress" &&
        part.state.status === "running"
      )
        part = {
          ...part,
          state: { ...part.state, metadata: event.data.metadata },
        };
      if (event.type === "session.tool.success") {
        const attachments = event.data.content.flatMap(
          (content, index): FilePart[] =>
            content.type === "file"
              ? [
                  {
                    id: `${event.data.id}:file:${index}`,
                    sessionID: sessionId,
                    messageID: event.data.assistantMessageID,
                    type: "file",
                    url: content.uri,
                    mime: content.mime,
                    filename: content.name,
                  },
                ]
              : [],
        );
        part = {
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            output: toolDisplayText(event.data.content, event.data.metadata),
            title: part.tool,
            metadata: event.data.metadata ?? {},
            time: {
              start:
                "time" in part.state ? part.state.time.start : event.created,
              end: event.created,
            },
            attachments,
          },
        };
      }
      if (event.type === "session.tool.failed")
        part = {
          ...part,
          state: {
            status: "error",
            input: part.state.input,
            error: event.data.error.message,
            metadata: event.data.metadata,
            time: {
              start:
                "time" in part.state ? part.state.time.start : event.created,
              end: event.created,
            },
          },
        };
      entry.toolParts.set(key, part);
      const mapped = toUIParts(part);
      cache.setQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
        (current = []) =>
          mapped.reduce(
            (messages, value) =>
              upsertPart(
                messages,
                event.data.assistantMessageID,
                ("toolCallId" in value
                  ? value.toolCallId
                  : getPartMetadataId(value)) ?? part.id,
                value,
              ),
            current,
          ),
      );
      useSessionActivityStore
        .getState()
        .markAssistantOutput(
          workspaceId,
          sessionId,
          event.data.assistantMessageID,
          { allowUnknownMessageRole: true },
        );
      if (event.type === "session.tool.success") {
        if (part.tool === "todowrite") {
          const todos = projectNativeTodos(event.data.metadata?.todos, part.id);
          if (todos) cache.setQueryData(todoKey(workspaceId, sessionId), todos);
        }
        void cache.invalidateQueries({
          queryKey: ["artifact-panel", workspaceId],
        });
        if (Array.isArray(event.data.metadata?.todos))
          void cache.invalidateQueries({
            queryKey: snapshotKey(workspaceId, sessionId),
            exact: true,
          });
      }
      return;
    }
    case "session.step.ended":
    case "session.step.failed":
      void publishMessage(sessionId, event.data.assistantMessageID);
      return;
    case "session.inbox.delivered":
      void publishMessage(sessionId, event.data.inboxID);
      return;
    case "session.synthetic":
    case "session.skill.activated":
    case "session.shell.started":
    case "session.shell.ended":
      refreshSnapshot(sessionId);
      return;
    case "session.compaction.started":
      useSessionActivityStore
        .getState()
        .setCompacting(workspaceId, sessionId, true);
      refreshSnapshot(sessionId);
      return;
    case "session.compaction.ended":
    case "session.compaction.failed":
      useSessionActivityStore
        .getState()
        .setCompacting(workspaceId, sessionId, false);
      refreshSnapshot(sessionId);
      return;
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const snapshot = cache.getQueryData<LegalworkSessionSnapshot>(
        snapshotKey(workspaceId, sessionId),
      );
      const provider = snapshot?.messages.findLast(
        (message) => message.info.role === "assistant",
      )?.info.providerID;
      const usageLimitStop = consumeProviderUsageLimitStop(sessionId);
      const stopped =
        event.type === "session.execution.interrupted" && !usageLimitStop;
      const error =
        event.type === "session.execution.failed"
          ? event.data.error
          : undefined;
      const text =
        usageLimitStop ??
        (stopped
          ? t("chat.stopped")
          : describeOpencodeSessionError(error, "Session failed", provider));
      useComposerStateStore.getState().setQueuePaused(sessionId, true);
      if (stopped)
        useSessionActivityStore.getState().clearError(workspaceId, sessionId);
      else
        useSessionActivityStore
          .getState()
          .setError(workspaceId, sessionId, text);
      if (isTrackedSession(entry, sessionId))
        cache.setQueryData<UIMessage[]>(
          transcriptKey(workspaceId, sessionId),
          (current = []) =>
            upsertMessage(
              current,
              createSessionErrorUIMessage(
                latestAssistantMessageId(current) ?? sessionId,
                text,
                { stopped },
              ),
            ),
        );
      break;
    }
    case "session.execution.succeeded":
    case "session.idle":
      break;
    default:
      return;
  }
  flushDeltas(entry, workspaceId);
  setStatus(idleStatus);
  refreshSnapshot(sessionId);
  for (const key of entry.toolParts.keys())
    if (key.startsWith(`${sessionId}:`)) entry.toolParts.delete(key);
  for (const key of [
    ["artifact-panel", workspaceId],
    ["markdown-editor", workspaceId],
    ["workspace-files", workspaceId],
  ])
    void cache.invalidateQueries({ queryKey: key });
  const runStartedAt = takeTaskRunStart(sessionId);
  if (runStartedAt !== null)
    captureRunOutcome(
      workspaceId,
      sessionId,
      event.type === "session.execution.failed"
        ? "task_run_errored"
        : event.type === "session.execution.interrupted"
          ? "task_run_stopped"
          : "task_run_completed",
      { duration_ms: Date.now() - runStartedAt },
    );
  releaseRetainedSessionSoon(entry.input, entry, sessionId);
}

function scheduleDeltaFlush(entry: SyncEntry, workspaceId: string) {
  if (entry.deltaFlushScheduled) return;
  entry.deltaFlushScheduled = true;
  const run = () => {
    entry.deltaFlushScheduled = false;
    if (entry.deltaFlushBuffer.length === 0) return;
    flushDeltas(entry, workspaceId);
  };
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  ) {
    window.requestAnimationFrame(run);
  } else if (typeof window !== "undefined") {
    window.setTimeout(run, 50);
  } else {
    queueMicrotask(run);
  }
}

function flushDeltas(entry: SyncEntry, workspaceId: string) {
  const queryClient = getReactQueryClient();
  const pending = coalescePendingDeltas(entry.deltaFlushBuffer);
  entry.deltaFlushBuffer = [];

  // Group by session id so each transcript cache is touched at most once
  // per flush.
  const bySession = new Map<string, PendingDelta[]>();
  for (const item of pending) {
    const bucket = bySession.get(item.sessionId);
    if (bucket) bucket.push(item);
    else bySession.set(item.sessionId, [item]);
  }

  for (const [sessionId, items] of bySession) {
    queryClient.setQueryData<UIMessage[]>(
      transcriptKey(workspaceId, sessionId),
      (current = []) => {
        let next = current;
        const nextById = new Map(next.map((message) => [message.id, message]));
        // Track which message shells we've ensured exist this flush so we
        // don't call upsertMessage for the same message on every delta.
        const ensuredMessageIds = new Set<string>();
        for (const item of items) {
          if (!ensuredMessageIds.has(item.messageId)) {
            // Deltas are streamed assistant output; user messages arrive
            // as complete parts. Tool steps do not alternate speaker roles.
            const existing = nextById.get(item.messageId);
            const role = existing?.role ?? "assistant";
            const ensuredMessage = {
              id: item.messageId,
              role,
              parts: existing?.parts ?? [],
            };
            next = upsertMessage(next, ensuredMessage);
            nextById.set(item.messageId, ensuredMessage);
            ensuredMessageIds.add(item.messageId);
          }
          // Resolve the part kind from the transcript instead of trusting
          // the inbound delta event (opencode emits `field: "text"` for
          // both text and reasoning parts). If the part hasn't been
          // declared yet via `message.part.updated`, defer the delta into
          // `entry.pendingDeltas` so the part can be created with the
          // correct kind later. Without this, every delta lands as a text
          // part — and reasoning content leaks into the response markdown
          // until the next reload reconstructs the transcript from the
          // snapshot.
          const ownerMessage = nextById.get(item.messageId);
          const ownerPartsById = new Map(
            (ownerMessage?.parts ?? []).flatMap((part) => {
              const id =
                part.type === "dynamic-tool"
                  ? part.toolCallId
                  : getPartMetadataId(part);
              return id ? [[id, part] as const] : [];
            }),
          );
          const ownerPart = ownerPartsById.get(item.partId);

          if (!ownerPart) {
            const existing = entry.pendingDeltas.get(item.partId) ?? {
              messageId: item.messageId,
              reasoning: item.reasoning,
              text: "",
            };
            existing.text += item.delta;
            entry.pendingDeltas.set(item.partId, existing);
            continue;
          }

          const reasoning = ownerPart.type === "reasoning";
          next = appendDelta(
            next,
            item.messageId,
            item.partId,
            item.delta,
            reasoning,
          );
        }
        return next;
      },
    );
  }
}

function startSync(input: SyncOptions) {
  const client = createClient(input.baseUrl, undefined, {
    token: input.legalworkToken,
    mode: "legalwork",
  });
  const controller = new AbortController();
  const entry = syncs.get(syncKey(input));
  if (entry) entry.client = client;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let activeConnectionController: AbortController | null = null;
  let lastEventAt = Date.now();
  let retryDelayMs = 1_000;
  const staleStreamMs = 30_000;

  const scheduleRetry = () => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    activeConnectionController = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
  };

  const connect = async () => {
    const connectionController = new AbortController();
    activeConnectionController = connectionController;
    try {
      const sub = client.event.subscribe({
        signal: connectionController.signal,
        onActivity: () => {
          lastEventAt = Date.now();
        },
      });
      retryDelayMs = 1_000;
      lastEventAt = Date.now();
      if (entry)
        for (const id of new Set([
          ...entry.trackedSessionRefs.keys(),
          ...entry.retainedSessionTimers.keys(),
        ]))
          void getReactQueryClient().invalidateQueries({
            queryKey: snapshotKey(input.workspaceId, id),
            exact: true,
          });
      let recoveredConnection = false;
      for await (const raw of sub) {
        if (controller.signal.aborted || connectionController.signal.aborted)
          return;
        lastEventAt = Date.now();
        const event = normalizeEvent(raw);
        if (!event) continue;
        if (!entry) continue;
        // The SDK may reconnect inside the same async iterator. Every new
        // server.connected event therefore needs its own authoritative read.
        if (!recoveredConnection || event.type === "server.connected") {
          recoveredConnection = true;
          for (const id of new Set([
            ...entry.trackedSessionRefs.keys(),
            ...entry.retainedSessionTimers.keys(),
          ])) {
            void getReactQueryClient().invalidateQueries({
              queryKey: snapshotKey(input.workspaceId, id),
              exact: true,
            });
          }
          const snapshot = createInteractionSnapshot();
          snapshot.deletedSessions = new Set(entry.deletedSessionIds);
          entry.interactionSnapshot = snapshot;
          void refreshWorkspaceInteractions({
            client,
            workspaceId: input.workspaceId,
            snapshot,
            isCurrent: (id) =>
              !disposed &&
              !connectionController.signal.aborted &&
              entry.interactionSnapshot === snapshot &&
              (!id || !entry.deletedSessionIds.has(id)),
            onSessionUpdated: (update) => {
              for (const listener of entry.sessionUpdatedListeners)
                listener(update);
            },
          }).finally(() => {
            if (entry.interactionSnapshot === snapshot)
              entry.interactionSnapshot = null;
          });
        }
        applyEvent(entry, input.workspaceId, event);
      }
      if (
        !controller.signal.aborted &&
        activeConnectionController === connectionController
      )
        scheduleRetry();
    } catch (error) {
      if (
        !controller.signal.aborted &&
        (connectionController.signal.aborted || shouldRetrySyncSubscribe(error))
      ) {
        scheduleRetry();
      }
    } finally {
      if (activeConnectionController === connectionController)
        activeConnectionController = null;
    }
  };

  void connect();
  watchdogTimer = setInterval(() => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    const active = activeConnectionController;
    if (!active || active.signal.aborted) return;
    if (Date.now() - lastEventAt < staleStreamMs) return;
    active.abort();
    scheduleRetry();
  }, 10_000);

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    activeConnectionController?.abort();
    controller.abort();
  };
}

export function ensureWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (existing) {
    if (existing.disposeTimer) {
      clearTimeout(existing.disposeTimer);
      existing.disposeTimer = null;
    }
    if (input.onSessionUpdated)
      existing.sessionUpdatedListeners.add(input.onSessionUpdated);
    if (input.onSessionStatus)
      existing.sessionStatusListeners.add(input.onSessionStatus);
    existing.refs += 1;
    return () => releaseWorkspaceSessionSync(input);
  }

  syncs.set(key, {
    input,
    client: null,
    interactionSnapshot: null,
    resolvingLineages: new Map(),
    deletedSessionIds: new Set(),
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionUpdatedListeners: new Set(
      input.onSessionUpdated ? [input.onSessionUpdated] : [],
    ),
    sessionStatusListeners: new Set(
      input.onSessionStatus ? [input.onSessionStatus] : [],
    ),
    toolParts: new Map(),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushScheduled: false,
  });

  const created = syncs.get(key)!;
  created.dispose = startSync(input);

  return () => releaseWorkspaceSessionSync(input);
}

function releaseWorkspaceSessionSync(input: SyncOptions) {
  const key = syncKey(input);
  const existing = syncs.get(key);
  if (!existing) return;
  if (input.onSessionUpdated)
    existing.sessionUpdatedListeners.delete(input.onSessionUpdated);
  if (input.onSessionStatus)
    existing.sessionStatusListeners.delete(input.onSessionStatus);
  existing.refs -= 1;
  if (existing.refs > 0) return;
  if (existing.retainedSessionTimers.size === 0) {
    disposeWorkspaceSync(key, existing);
  }
}

export function seedTodoState(
  workspaceId: string,
  sessionId: string,
  todos: Todo[],
  snapshotStartedAt = 0,
) {
  const queryClient = getReactQueryClient();
  const key = todoKey(workspaceId, sessionId);
  const current = queryClient.getQueryState(key);
  // Cached snapshots are replayed when session metadata changes. Only a
  // fresh read may replace an existing plan, and never a newer live update.
  if (current?.data !== undefined && current.dataUpdatedAt >= snapshotStartedAt)
    return;
  queryClient.setQueryData(key, todos);
}

export function seedSessionState(
  workspaceId: string,
  snapshot: LegalworkSessionSnapshot,
) {
  seedInteractionSession(workspaceId, snapshot.session);
  const queryClient = getReactQueryClient();
  const key = transcriptKey(workspaceId, snapshot.session.id);
  const incoming = snapshotToUIMessages(snapshot);
  const existing = queryClient.getQueryData<UIMessage[]>(key);

  useSessionActivityStore
    .getState()
    .seedSessionRun(
      workspaceId,
      snapshot.session.id,
      snapshot.status,
      assistantOutputAfterLatestUser(incoming),
    );

  // The snapshot's revert cursor is authoritative: messages at/after it are
  // reverted server-side, so the cache must not keep them alive (a later
  // merge would resurrect them once the server deletes them on next prompt).
  queryClient.setQueryData(
    key,
    applyRevertCursor(
      reconcileTranscriptMessages({
        currentMessages: existing ?? [],
        snapshotMessages: incoming,
        reason: "snapshot",
      }),
      snapshot.session.revert?.messageID ?? null,
    ),
  );

  // An older idle snapshot must not overwrite a newer busy event / accepted prompt.
  const activity =
    useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[
      snapshot.session.id
    ];
  if (isLiveStatus(snapshot.status) || !activity?.runActive) {
    queryClient.setQueryData(
      statusKey(workspaceId, snapshot.session.id),
      snapshot.status,
    );
  }
  seedTodoState(workspaceId, snapshot.session.id, snapshot.todos);
}

/** Keep an accepted prompt visible while the first snapshot/SSE catches up. */
export function seedSubmittedMessage(
  workspaceId: string,
  sessionId: string,
  message: UIMessage,
) {
  const queryClient = getReactQueryClient();
  queryClient.setQueryData<UIMessage[]>(
    transcriptKey(workspaceId, sessionId),
    (current = []) =>
      reconcileTranscriptMessages({
        currentMessages: current,
        snapshotMessages: [message],
      }),
  );
  useSessionActivityStore
    .getState()
    .setRunStatus(workspaceId, sessionId, { type: "busy" });
  queryClient.setQueryData(statusKey(workspaceId, sessionId), { type: "busy" });
}

/**
 * Surface a client-originated terminal error in the chat transcript.
 *
 * Uses the same per-turn keying as the live `session.error` handler (errored
 * assistant message id, session id fallback) so the injected message
 * reconciles with — instead of duplicating — the error the engine reports for
 * the same turn. Used by the free-tier daily-limit and budget-exceeded stop
 * paths, which know the run failed before the engine's abort error arrives.
 */
export function injectSessionErrorMessage(
  workspaceId: string,
  sessionId: string,
  text: string,
) {
  const queryClient = getReactQueryClient();
  useSessionActivityStore.getState().setError(workspaceId, sessionId, text);
  queryClient.setQueryData<UIMessage[]>(
    transcriptKey(workspaceId, sessionId),
    (current = []) => {
      const turnKey = latestAssistantMessageId(current) ?? sessionId;
      return upsertMessage(current, createSessionErrorUIMessage(turnKey, text));
    },
  );
}

/**
 * Apply a server-confirmed revert to the local session caches.
 *
 * `session.revert` only reaches the renderer through the snapshot cache, so
 * after a successful `session.revert` call this stamps the returned revert
 * cursor into the cached snapshot, truncates the live transcript cache, and
 * refetches the snapshot to pick up the server's post-revert truth. Without
 * this the UI keeps rendering the old transcript until a full reload.
 */
export function applySessionRevert(workspaceId: string, session: Session) {
  const queryClient = getReactQueryClient();
  const revertMessageId = session.revert?.messageID ?? null;

  queryClient.setQueryData<LegalworkSessionSnapshot>(
    snapshotKey(workspaceId, session.id),
    (current) =>
      current
        ? {
            ...current,
            session: { ...current.session, revert: session.revert },
          }
        : current,
  );
  queryClient.setQueryData<UIMessage[]>(
    transcriptKey(workspaceId, session.id),
    (current = []) => applyRevertCursor(current, revertMessageId),
  );
  void queryClient.invalidateQueries({
    queryKey: snapshotKey(workspaceId, session.id),
  });
}

export function trackWorkspaceSessionSync(
  input: SyncOptions,
  sessionId: string | null | undefined,
) {
  const normalizedSessionId = sessionId?.trim() ?? "";
  if (!normalizedSessionId) return () => {};

  const entry = syncs.get(syncKey(input));
  if (!entry) return () => {};

  const retainedTimer = entry.retainedSessionTimers.get(normalizedSessionId);
  if (retainedTimer) {
    clearTimeout(retainedTimer);
    entry.retainedSessionTimers.delete(normalizedSessionId);
  }

  entry.trackedSessionRefs.set(
    normalizedSessionId,
    (entry.trackedSessionRefs.get(normalizedSessionId) ?? 0) + 1,
  );

  return () => {
    const current = entry.trackedSessionRefs.get(normalizedSessionId) ?? 0;
    if (current <= 1) {
      entry.trackedSessionRefs.delete(normalizedSessionId);
      retainSession(input, entry, normalizedSessionId);
      return;
    }
    entry.trackedSessionRefs.set(normalizedSessionId, current - 1);
  };
}

export function trackWorkspaceSessionsSync(
  input: SyncOptions,
  sessionIds: Array<string | null | undefined>,
) {
  const seen = new Set<string>();
  const releases = sessionIds.flatMap((sessionId) => {
    const id = sessionId?.trim() ?? "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [trackWorkspaceSessionSync(input, id)];
  });
  return () => {
    for (const release of releases) release();
  };
}

export function __createWorkspaceSessionSyncForTest(input: SyncOptions,client?:Client) {
  const key = syncKey(input);
  syncs.set(key, {
    input,
    client: client ?? null,
    interactionSnapshot: null,
    resolvingLineages: new Map(),
    deletedSessionIds: new Set(),
    refs: 1,
    dispose: () => {},
    disposeTimer: null,
    trackedSessionRefs: new Map(),
    retainedSessionTimers: new Map(),
    sessionUpdatedListeners: new Set(),
    sessionStatusListeners: new Set(),
    toolParts: new Map(),
    pendingDeltas: new Map(),
    deltaFlushBuffer: [],
    deltaFlushScheduled: false,
  });
  return () => {
    const entry = syncs.get(key);
    if (entry) {
      for (const timer of entry.retainedSessionTimers.values())
        clearTimeout(timer);
    }
    syncs.delete(key);
  };
}

export function __hasWorkspaceSessionSyncForTest(input: SyncOptions) {
  return syncs.has(syncKey(input));
}

export function __disposeWorkspaceSessionSyncForTest(input: SyncOptions) {
  const key = syncKey(input);
  const entry = syncs.get(key);
  if (!entry) return;
  entry.refs = 0;
  disposeWorkspaceSync(key, entry);
}

export function __applySessionSyncEventForTest(
  input: SyncOptions,
  event: OpencodeEvent,
) {
  const entry = syncs.get(syncKey(input));
  if (!entry) return;
  applyEvent(entry, input.workspaceId, event);
}
