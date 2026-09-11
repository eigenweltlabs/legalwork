import { buildStorageRefUri, parseStorageRef, type StorageRef } from "@/components/markdown/storage-ref";

/** What a composer `@token` refers to: an agent, a workspace file, an uploaded file, a LegalMemory file, a connected-storage file, or a macOS app. */
export type ComposerMentionKind = "agent" | "file" | "memory" | "upload" | "storage" | "app";

/**
 * Percent-encode a mention value so it can be embedded in the draft as a single `@token` with no spaces.
 * @param value The raw mention value to encode.
 */
export function encodeComposerMentionValue(value: string) {
  return value.replaceAll("%", "%25").replaceAll(" ", "%20");
}

/**
 * Recover the original mention value from its encoded form. Preserves literal `%20` sequences in the original.
 * @param value The encoded mention value to decode.
 */
export function decodeComposerMentionValue(value: string) {
  return value.replaceAll("%20", " ").replaceAll("%25", "%");
}

export type LegalMemoryComposerMention = {
  documentId: string;
  label: string;
  /** Workspace-relative location of the copy the app downloaded before the
   * mention was inserted. It stays metadata on the memory pill and must never
   * be promoted to a binary chat attachment. */
  localPath?: string;
  uri: string;
};

const LEGALMEMORY_DOCUMENT_MENTION = /^legalmemory:\/\/document\/([^?\s]+)(?:\?([^\s]*))?$/i;

/** Keep the filename in the editor token while retaining the document id the
 * agent needs. The query is UI metadata; `uri` below is the canonical lookup
 * reference sent to the model. */
export function createLegalMemoryComposerMention(documentId: string, label: string, localPath?: string): string {
  const params = new URLSearchParams({ name: label });
  if (localPath?.trim()) params.set("path", localPath.trim());
  return `legalmemory://document/${encodeURIComponent(documentId)}?${params.toString()}`;
}

export function parseLegalMemoryComposerMention(value: string): LegalMemoryComposerMention | null {
  const match = LEGALMEMORY_DOCUMENT_MENTION.exec(value.trim());
  if (!match?.[1]) return null;
  try {
    const documentId = decodeURIComponent(match[1]);
    if (!documentId) return null;
    const params = new URLSearchParams(match[2] ?? "");
    const label = params.get("name") ?? documentId;
    const localPath = params.get("path")?.trim() || undefined;
    return {
      documentId,
      label: label.trim() || documentId,
      ...(localPath ? { localPath } : {}),
      uri: `legalmemory://document/${encodeURIComponent(documentId)}`,
    };
  } catch {
    return null;
  }
}

export function legalMemoryComposerInstruction(value: string): string {
  const mention = parseLegalMemoryComposerMention(value);
  if (!mention) return value;
  if (mention.localPath) {
    return `Read the downloaded LegalMemory copy at workspace path "${mention.localPath}" before answering. It is "${mention.label}" (${mention.uri}, document_id ${mention.documentId}). Use a document-capable tool appropriate for its format (for example, extract or convert DOCX rather than reading it as plain text). This is a local path reference, not a binary chat attachment.`;
  }
  return `Use LegalMemory to fetch and read "${mention.label}" (${mention.uri}, document_id ${mention.documentId}) before answering. This is a LegalMemory reference, not a local workspace file.`;
}

export type StorageComposerMention = StorageRef;

/** A connected-storage object has no LegalMemory document id, so it is addressed
 * by connection plus path. Parsing lives in storage-ref.ts so the composer, the
 * user-turn chip and the markdown renderer all read the same shape. */
export function createStorageComposerMention(
  connectionId: string,
  path: string,
  label: string,
  localPath?: string,
): string {
  return buildStorageRefUri(connectionId, path, label, localPath);
}

export function parseStorageComposerMention(value: string): StorageComposerMention | null {
  return parseStorageRef(value);
}

export function storageComposerInstruction(value: string): string {
  const mention = parseStorageComposerMention(value);
  if (!mention) return value;
  if (mention.localPath) {
    return `Read the downloaded storage copy at workspace path "${mention.localPath}" before answering. It is "${mention.label}" from the connected storage connection ${mention.connectionId} (${mention.uri}). Use a document-capable tool appropriate for its format (for example, extract or convert XLSX or DOCX rather than reading it as plain text). This is a local path reference, not a binary chat attachment.`;
  }
  return `Use the storage tools to fetch and read "${mention.label}" from connection ${mention.connectionId} (${mention.uri}) before answering. This is a connected-storage reference, not a local workspace file.`;
}

/** Visible representation persisted in the user turn, rendered as a chip by the
 * user-turn renderer exactly like the LegalMemory citation. The checked-out
 * copy stays in the query so the chip can open it without another round-trip. */
export function storageComposerDisplayText(value: string): string {
  const mention = parseStorageComposerMention(value);
  if (!mention) return value;
  const label = mention.label.replaceAll("[", "").replaceAll("]", "");
  return `[${label || mention.path}](${buildStorageRefUri(mention.connectionId, mention.path, undefined, mention.localPath)})`;
}

/** Visible representation persisted in the user turn. The transcript renderer
 * turns this ordinary LegalMemory citation into a compact clickable pill. */
export function legalMemoryComposerDisplayText(value: string): string {
  const mention = parseLegalMemoryComposerMention(value);
  if (!mention) return value;
  const label = mention.label.replaceAll("[", "").replaceAll("]", "");
  return `[${label || mention.documentId}](${mention.uri})`;
}
