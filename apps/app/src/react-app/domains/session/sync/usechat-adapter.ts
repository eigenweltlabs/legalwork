/** @jsxImportSource react */
import type { UIMessage } from "ai";
import { textPartProviderMetadata } from "./assistant-message-sender";
import { scheduledTextMetadata } from "../../scheduled-tasks/scheduled-message";
import type { FilePart, Part, ToolPart } from "@/app/lib/opencode-view";

import type { LegalworkSessionSnapshot } from "../../../../app/lib/legalwork-server";
import { safeStringify } from "../../../../app/utils";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../../../app/types";
import { eigenweltProviderRecoveryMessage } from "./eigenwelt-provider-error";
import {
  parseDynamicToolUIParts,
  parseStructuredOutputUIPart,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";
import { t } from "@/i18n";
import { eigenweltUsageLimitFromError, isAnthropicUsageLimitError, providerUsageLimitErrorText } from "@/app/lib/provider-usage-limit";

function recordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function firstStringValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function firstNumberValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function defaultErrorMessage(name: string | null, fallback: string) {
  if (name === "ProviderAuthError") return t("chat.error_provider_auth");
  if (name === "MessageOutputLengthError") return t("chat.error_output_limit");
  if (name === "StructuredOutputError") return t("chat.error_structured_output");
  if (name === "ContextOverflowError") return t("chat.error_context_window");
  if (name === "MessageAbortedError") return t("chat.error_interrupted");
  return fallback;
}

export function isSessionAbortError(error: unknown) {
  return recordValue(error, "name") === "MessageAbortedError" || ["aborted","interrupted","MessageAbortedError","AbortError"].includes(String(recordValue(error,"type") ?? ""));
}

/**
 * Unsupported file parts live in server-side session history, so the same
 * provider error replays on every later prompt. Tell the user how to escape.
 */
function withAttachmentRecoveryHint(text: string) {
  if (!text.includes("file part media type") || !text.includes("not supported")) return text;
  return `${text}\nAn attached file in this conversation uses a format the model can't read. Revert the conversation to before the attachment was sent, or start a new session.`;
}

function describeErrorText(text: string, provider: string | null = null) {
  if (/request (?:entity|body) too large|request_too_large|\b413\b/i.test(text)) return t("chat.error_request_size");
  const recovery = eigenweltProviderRecoveryMessage({ status: null, provider, texts: [text] });
  if (recovery) return recovery;
  return withAttachmentRecoveryHint(text);
}

export function describeOpencodeSessionError(error: unknown, fallback = "Session failed", providerId?: string) {
  if (isSessionAbortError(error)) return t("chat.stopped");
  const limit = providerId === "eigenwelt" ? eigenweltUsageLimitFromError(error) : null;
  if (limit) return providerUsageLimitErrorText("eigenwelt", limit);
  if (isAnthropicUsageLimitError(error)) return providerUsageLimitErrorText(providerId ?? "anthropic");
  if (error instanceof Error) return describeErrorText(error.message || fallback, providerId ?? null);
  if (typeof error === "string") return describeErrorText(error.trim() || fallback, providerId ?? null);
  if (!error || typeof error !== "object") return fallback;

  const data = recordValue(error, "data");
  const cause = recordValue(error, "cause");
  const causeData = recordValue(cause, "data");
  const records = [error, data, cause, causeData].filter(Boolean);
  const name = firstStringValue(records, ["name", "type"]);
  const message = firstStringValue(records, ["message", "detail", "reason", "error"]);
  const status = firstNumberValue(records, ["statusCode", "status"]);
  const provider = firstStringValue(records, ["providerID", "providerId", "provider"]) ?? providerId ?? null;
  const code = firstStringValue(records, ["code", "errorCode"]);
  const retries = firstNumberValue(records, ["retries", "retryCount"]);
  const responseBody = firstStringValue(records, ["responseBody", "body", "response"]);

  if (status === 413 || /request (?:entity|body) too large|request_too_large/i.test([message, responseBody].join(" "))) {
    return t("chat.error_request_size");
  }

  const recovery = eigenweltProviderRecoveryMessage({ status, provider, texts: [message, responseBody, code] });
  if (recovery) return recovery;
  const lines = [message ?? defaultErrorMessage(name, fallback)];
  if (status && !lines[0]?.includes(String(status))) lines.push(`Status: ${status}`);
  if (provider && !lines[0]?.includes(provider)) lines.push(`Provider: ${provider}`);
  if (code) lines.push(`Code: ${code}`);
  if (retries !== null) lines.push(`Retries: ${retries}`);
  if (responseBody && responseBody !== message) lines.push(`Response: ${responseBody}`);
  if (lines.some((line) => line !== fallback)) return withAttachmentRecoveryHint(lines.join("\n"));

  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : fallback;
}

function sessionErrorMessageId(turnKey: string) {
  return `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${turnKey}`;
}

/**
 * Build the synthetic chat message that surfaces a session error.
 *
 * The error is keyed to the *turn* that failed (`turnKey`), not the session.
 * Both the live `session.error` event and the snapshot reload derive the same
 * `turnKey` from the errored assistant message id, so they reconcile to one
 * message instead of duplicating — while a brand new error on a later turn
 * still produces its own message instead of overwriting the previous one.
 */
export function createSessionErrorUIMessage(turnKey: string, text: string, options?: { created?: number; stopped?: boolean }): UIMessage {
  const id = sessionErrorMessageId(turnKey);
  const created = options?.created;
  return {
    id,
    role: "assistant",
    metadata: { opencode: { ...(typeof created === "number" ? { created } : {}), stopped: options?.stopped ?? false } },
    parts: [{
      type: "text",
      text,
      state: "done",
      providerMetadata: { opencode: { partId: `${id}:text` } },
    }],
  };
}

function fileProviderMetadata(part: FilePart) {
  return {opencode:{partId:part.id,...(part.source ? {source:part.source}:{}),...(part.history ? {historicalAttachment:part.history}:{})}};
}

function getTextPartValue(part: Part) {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "reasoning") {
    return part.text;
  }
  return "";
}

function mapFilePart(part: FilePart): UIMessage["parts"][number] {
  return {
    type: "file",
    url: part.url,
    filename: part.filename,
    mediaType: part.mime,
    providerMetadata: fileProviderMetadata(part),
  };
}

function mapFileSourcePart(part: FilePart): UIMessage["parts"][number] | null {
  const source = part.source;
  if (!source) return null;

  const sourceId = `${part.id}:source`;
  const providerMetadata = { opencode: { partId: sourceId, sourcePartId: part.id, source } };

  if (source.type === "resource") {
    if (source.uri.startsWith("http://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    if (source.uri.startsWith("https://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.uri, providerMetadata };
  }

  if (source.type === "symbol") {
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.name, filename: source.path, providerMetadata };
  }

  return { type: "source-document", sourceId, mediaType: part.mime, title: source.path, filename: source.path, providerMetadata };
}

function mapFileParts(part: FilePart): UIMessage["parts"] {
  const sourcePart = mapFileSourcePart(part);
  if (sourcePart) return [mapFilePart(part), sourcePart];
  return [mapFilePart(part)];
}

function mapSnapshotToolParts(part: ToolPart): UIMessage["parts"] {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    const mapped = parseStructuredOutputUIPart(part);
    return mapped ? [mapped] : [];
  }

  const mapped = parseDynamicToolUIParts(part);

  if (part.state.status === "completed" && part.state.attachments) {
    return [...mapped, ...part.state.attachments.flatMap(mapFileParts)];
  }

  return mapped;
}

/** Internal stop notes stay hidden; their structured reason explains the
 * matching aborted turn instead of making it look like a manual Stop. */
export function toolRecoveryStop(part: Part): { messageID?: string } | null {
  if (part.type !== "text" || !part.synthetic) return null;
  const stop = recordValue(part.metadata, "legalworkStop");
  const messageID = recordValue(stop, "messageID");
  if (recordValue(stop, "reason") === "repeated-invalid-tool-calls" && typeof messageID === "string") return { messageID };
  // Read stop notes saved before structured reasons were introduced.
  if (/^Stopped because identical invalid calls to \S+ continued for three assistant steps after correction guidance\./.test(part.text)) return {};
  return null;
}

function toolRecoveryStoppedTurns(snapshot: LegalworkSessionSnapshot) {
  const turns = new Set<string>();
  const saved = snapshot.session.metadata?.legalworkToolStops;
  for (const message of snapshot.messages) {
    if (message.info.role === "assistant" && recordValue(recordValue(saved, message.info.id), "reason") === "repeated-invalid-tool-calls") turns.add(message.info.id);
  }
  for (const [index, note] of snapshot.messages.entries()) {
    if (note.info.role !== "user") continue;
    for (const part of note.parts) {
      const stop = toolRecoveryStop(part);
      if (!stop) continue;
      const failed = stop.messageID ? snapshot.messages.findIndex((message) => message.info.id === stop.messageID) : -1;
      if (stop.messageID && (failed < 0 || failed >= index)) continue;
      if (stop.messageID && snapshot.messages.slice(failed + 1, index).some(message => message.info.role === "user" && message.parts.some(part => part.type === "text" && !part.synthetic))) continue;
      let explained = false;
      for (let previous = index - 1; previous >= Math.max(0, failed); previous--) {
        const info = snapshot.messages[previous].info;
        if (info.role === "user" && snapshot.messages[previous].parts.some(part => part.type === "text" && !part.synthetic)) break;
        if (info.role !== "assistant" || !isSessionAbortError(info.error)) continue;
        turns.add(info.id);
        explained = true;
        break;
      }
      // V2 can stop between steps; then its idle marker records the interruption
      // without attaching an error to the last assistant message.
      if (!explained && stop.messageID && snapshot.messages[failed]?.info.role === "assistant") turns.add(stop.messageID);
    }
  }
  return turns;
}

export function snapshotToUIMessages(snapshot: LegalworkSessionSnapshot): UIMessage[] {
  const recoveryStops = toolRecoveryStoppedTurns(snapshot);
  return snapshot.messages.flatMap((message) => {
    const created = message.info.time?.created;
    const summary = message.info.role === "assistant" && "summary" in message.info && message.info.summary === true;
    const uiMessage = {
      id: message.info.id,
      role: message.info.role,
      metadata: { opencode: { ...(typeof created === "number" ? { created } : {}), ...(summary ? { summary: true } : {}), ...(message.info.role === "assistant" && (message.info.time.completed || message.info.error) ? { completed: true } : {}) } },
      parts: message.parts.flatMap<UIMessage["parts"][number]>((part) => {
        if (part.type === "text") {
          if (part.synthetic || part.ignored) return [];
          return [{
            type: "text",
            text: getTextPartValue(part),
            state: "done" as const,
            providerMetadata: { opencode: { ...scheduledTextMetadata(part).opencode, ...textPartProviderMetadata(part).opencode } },
          }];
        }
        if (part.type === "reasoning") {
          return [{
            type: "reasoning",
            text: getTextPartValue(part),
            state: "done" as const,
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "file") {
          return mapFileParts(part);
        }
        if (part.type === "tool") {
          return mapSnapshotToolParts(part);
        }
        if (part.type === "agent") {
          return [{
            type: "text",
            text: part.name ? `@${part.name}` : "@agent",
            state: "done",
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "step-start") {
          return [{ type: "step-start", providerMetadata: { opencode: { partId: part.id } } }];
        }
        return [];
      }),
    };

    // Surface a failed turn as its own synthetic error message keyed by the
    // errored assistant message id. The live `session.error` event keys its
    // message off the latest assistant turn the same way, so the two
    // reconcile to one message instead of duplicating — while a later turn's
    // error still gets its own message. An empty assistant carcass for the
    // errored turn is dropped so the error reads as that turn's outcome.
    const error = message.info.role === "assistant" && "error" in message.info ? message.info.error : undefined;
    if (!error && !recoveryStops.has(message.info.id)) return [uiMessage];

    const providerId = message.info.role === "assistant" ? message.info.providerID : undefined;
    const text = recoveryStops.has(message.info.id) ? t("chat.stopped_invalid_tool_calls") : describeOpencodeSessionError(error, "Session failed", providerId);
    const errorMessage = createSessionErrorUIMessage(message.info.id, text, { created, stopped: recoveryStops.has(message.info.id) || isSessionAbortError(error) });
    return uiMessage.parts.length > 0 ? [uiMessage, errorMessage] : [errorMessage];
  });
}
