import { createHash } from "node:crypto";
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
import { ApiError, findApiError } from "./errors.js";
import { assertSessionImageTarget as targetSession, sessionImageUnavailable as unavailable, type SessionImageSource } from "./session-image-authority.js";
import type { WorkspaceInfo } from "./types.js";
import type { HistoryImageMetadata, HistoryImagePage, HistoryImagePayload, HistoryImageReference } from "./session-history-image-schema.js";

export interface HistoryImageSource extends SessionImageSource {
  message: (sessionID: string, messageID: string, signal: AbortSignal) => Promise<SessionMessageInfo>;
  messages: (sessionID: string, cursor: string | undefined, signal: AbortSignal) => Promise<{
    data: SessionMessageInfo[]; cursor: { next?: string | null; previous?: string | null };
  }>;
}
export function nativeHistoryImageSource(client: OpenCodeClient): HistoryImageSource {
  return {
    session: (sessionID, signal) => client.session.get({ sessionID }, { signal }),
    message: (sessionID, messageID, signal) => client.session.message.get({ sessionID, messageID }, { signal }),
    messages: (sessionID, cursor, signal) => client.message.list({ sessionID, ...(cursor ? { cursor } : { order: "desc" }) }, { signal }),
  };
}

function inlineImage(mime: string, uri: string): Buffer | undefined {
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return;
  const prefix = `data:${mime};base64,`;
  if (!uri.startsWith(prefix)) return;
  const encoded = uri.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  // Decode/re-encode validates canonical base64 without a repeated-group regex,
  // which can exhaust a runtime's regexp engine on otherwise valid large images.
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) return;
  return bytes;
}

function storedImage(sessionID: string, messageID: string, selector: HistoryImageReference["selector"], mime: string, uri: string, name?: string): HistoryImagePayload | undefined {
  const bytes = inlineImage(mime, uri);
  if (!bytes) return;
  return {
    image: { reference: { sessionID, messageID, selector, sha256: createHash("sha256").update(bytes).digest("hex") },
      mime, ...(name === undefined ? {} : { name }), bytes: bytes.length, provenance: "stored-session-image" },
    uri,
  };
}

function messageImage(sessionID: string, message: SessionMessageInfo, selector: HistoryImageReference["selector"]): HistoryImagePayload | undefined {
  if (selector.kind === "user-file") {
    const file = message.type === "user" ? message.files?.[selector.fileIndex] : undefined;
    return file && storedImage(sessionID, message.id, selector, file.mime, `data:${file.mime};base64,${file.data}`, file.name);
  }
  const tool = message.type === "assistant" ? message.content[selector.toolIndex] : undefined;
  const content = tool?.type === "tool" && tool.state.status === "completed" ? tool.state.content[selector.contentIndex] : undefined;
  return content?.type === "file" ? storedImage(sessionID, message.id, selector, content.mime, content.uri, content.name ?? undefined) : undefined;
}
function messageImages(sessionID: string, message: SessionMessageInfo): HistoryImagePayload[] {
  const selectors: HistoryImageReference["selector"][] = message.type === "user"
    ? (message.files ?? []).map((_file, fileIndex) => ({ kind: "user-file", fileIndex }))
    : message.type === "assistant" ? message.content.flatMap((tool, toolIndex) => tool.type === "tool" && tool.state.status === "completed"
      ? tool.state.content.map((_content, contentIndex) => ({ kind: "tool-content", toolIndex, contentIndex })) : []) : [];
  return selectors.flatMap(selector => { const image = messageImage(sessionID, message, selector); return image ? [image] : []; });
}

export async function listHistoryImages(source: HistoryImageSource, workspace: WorkspaceInfo, callerID: string, targetID: string, cursor: string | undefined, signal: AbortSignal): Promise<HistoryImagePage> {
  const { session: target, visited } = await targetSession(source, workspace, callerID, targetID, signal);
  const page = await source.messages(targetID, cursor, signal);
  const images: HistoryImageMetadata[] = page.data.flatMap(message => messageImages(targetID, message).map(item => item.image));
  let parent: HistoryImagePage["parent"] = { status: "none" };
  if (target.parentID && visited.has(target.parentID)) parent = { status: "unavailable" };
  else if (target.parentID) {
    try {
      await targetSession(source, workspace, callerID, target.parentID, signal);
      parent = { status: "available", sessionID: target.parentID };
    } catch (error) {
      if (findApiError(error)?.status !== 404) throw error;
      parent = { status: "unavailable" };
    }
  }
  // Re-resolve lineage after the asynchronous read; moving/reparenting a chat
  // cannot release bytes from the earlier project or from an unrelated branch.
  await targetSession(source, workspace, callerID, targetID, signal);
  signal.throwIfAborted();
  return { sessionID: targetID, images, cursor: { next: page.cursor.next ?? null, previous: page.cursor.previous ?? null }, coverage: "native-message-page", parent };
}

export async function readHistoryImage(source: HistoryImageSource, workspace: WorkspaceInfo, callerID: string, reference: HistoryImageReference, signal: AbortSignal): Promise<HistoryImagePayload> {
  await targetSession(source, workspace, callerID, reference.sessionID, signal);
  const message = await source.message(reference.sessionID, reference.messageID, signal);
  if (message.id !== reference.messageID) unavailable();
  const image = messageImage(reference.sessionID, message, reference.selector);
  if (!image) unavailable();
  if (image.image.reference.sha256 !== reference.sha256)
    throw new ApiError(409, "history_image_changed", "The stored image changed. List its current metadata before reading it.");
  await targetSession(source, workspace, callerID, reference.sessionID, signal);
  signal.throwIfAborted();
  return image;
}
