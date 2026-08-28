/** What a composer `@token` refers to: an agent, a workspace or LegalMemory file, or a macOS app. */
export type ComposerMentionKind = "agent" | "file" | "memory" | "app";

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
  uri: string;
};

const LEGALMEMORY_DOCUMENT_MENTION = /^legalmemory:\/\/document\/([^?\s]+)(?:\?name=(.*))?$/i;

/** Keep the filename in the editor token while retaining the document id the
 * agent needs. The query is UI metadata; `uri` below is the canonical lookup
 * reference sent to the model. */
export function createLegalMemoryComposerMention(documentId: string, label: string): string {
  return `legalmemory://document/${encodeURIComponent(documentId)}?name=${encodeURIComponent(label)}`;
}

export function parseLegalMemoryComposerMention(value: string): LegalMemoryComposerMention | null {
  const match = LEGALMEMORY_DOCUMENT_MENTION.exec(value.trim());
  if (!match?.[1]) return null;
  try {
    const documentId = decodeURIComponent(match[1]);
    if (!documentId) return null;
    const label = match[2] ? decodeURIComponent(match[2]) : documentId;
    return {
      documentId,
      label: label.trim() || documentId,
      uri: `legalmemory://document/${encodeURIComponent(documentId)}`,
    };
  } catch {
    return null;
  }
}

export function legalMemoryComposerInstruction(value: string): string {
  const mention = parseLegalMemoryComposerMention(value);
  if (!mention) return value;
  return `Use LegalMemory to fetch and read "${mention.label}" (${mention.uri}, document_id ${mention.documentId}) before answering. This is a LegalMemory reference, not a local workspace file.`;
}
