/**
 * The documents a LegalMemory turn touched, taken from the tool results.
 *
 * Every result the appliance returns carries the identity of what it returned:
 * document_id, title, version status, and a citations array. That is the source
 * list, sitting in the transcript already.
 *
 * An earlier version of this asked the model to restate those ids as markdown
 * links and built the list by parsing its prose. That made a reliable fact
 * dependent on the least reliable part of the system: the model wrote them
 * sometimes, then stopped, and the sources and the graph disappeared with them.
 * Nothing here asks the model for anything.
 */

export type LegalMemoryDocument = {
  documentId: string;
  title: string;
  /** Version status as stored, e.g. "executed", "final", "draft". */
  versionStatus?: string;
  /** The matter this document belongs to, by id. Resolved to a title
   * separately: a hit names the matter only by id. */
  matterId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Tool output arrives as the serialized content; a transport that hands back
 * the value itself is equally valid, so accept both. */
function coerce(output: unknown): unknown {
  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }
  return output ?? null;
}

/**
 * Walk any LegalMemory result shape for things that identify a document.
 *
 * The tools disagree on structure: search returns a bare array of hits,
 * get_document an object, find_related_documents a root plus related. Rather
 * than special-case each and miss the next one, look for the pair that always
 * marks a document — an id and a title — wherever it appears.
 */
function collectFrom(value: unknown, into: Map<string, LegalMemoryDocument>, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectFrom(entry, into, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;

  const documentId = asString(record.document_id);
  const title = asString(record.title);
  if (documentId && title && !into.has(documentId)) {
    into.set(documentId, {
      documentId,
      title,
      versionStatus: asString(record.version_status),
      matterId: asString(record.matter_id),
    });
  }

  for (const [key, nested] of Object.entries(record)) {
    // Citations describe the document they hang off; descending into them adds
    // no new documents and would attribute a parent's id to a child object.
    if (key === "citations") continue;
    collectFrom(nested, into, depth + 1);
  }
}

/** Statuses the appliance treats as authoritative, badged so a draft is never
 * mistaken for the operative document. */
const FINAL_STATUSES = new Set(["executed", "final", "signed"]);

export function isAuthoritativeStatus(status: string | undefined): boolean {
  return status ? FINAL_STATUSES.has(status.toLowerCase()) : false;
}

/**
 * Every document named by this turn's LegalMemory tool results, in the order
 * they were first seen.
 */
export function collectLegalMemoryDocuments(outputs: readonly unknown[]): LegalMemoryDocument[] {
  const found = new Map<string, LegalMemoryDocument>();
  for (const output of outputs) collectFrom(coerce(output), found);
  return [...found.values()];
}
