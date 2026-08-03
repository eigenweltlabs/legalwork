/**
 * Source list from a LegalMemory search result.
 *
 * `search_semantic` and `search_filter` return ranked hits, each carrying the
 * document's identity, the version that matched, a passage excerpt, and the
 * citations that prove the caller was allowed to see it. The transcript showed
 * that as raw JSON; this turns it into the cited source list an answer should
 * be read alongside.
 *
 * Two things here are deliberate:
 *
 *   - The system badge comes from `citations[].source_objects[].connector`,
 *     the connector the object was actually synced from. It is never guessed
 *     from a path, so "iManage" on a row means iManage.
 *   - A hit with no citations is dropped. The appliance's own contract is that
 *     no factual claim may rest on a result with an empty citations array, so
 *     rendering one as a source would contradict it.
 */

export type LegalMemorySource = {
  documentId: string;
  title: string;
  /** Human-readable document type, e.g. "Agreement". */
  docType?: string;
  /** Version status as stored, e.g. "executed", "draft". */
  versionStatus?: string;
  /** Connector display name, e.g. "iManage", "SharePoint". */
  system?: string;
  excerpt?: string;
};

export type LegalMemorySourceList = {
  sources: LegalMemorySource[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** MCP hands the renderer serialized tool content; a transport that passes the
 * raw array through is equally valid, so accept both. */
function coerceHits(output: unknown): unknown[] | null {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return Array.isArray(output) ? output : null;
}

/** The connector the first authorized source object was synced from. Falls back
 * to the provider slug when a firm never named the connector. */
function systemOf(citations: unknown): string | undefined {
  if (!Array.isArray(citations)) return undefined;
  for (const citation of citations) {
    const record = asRecord(citation);
    const objects = record && Array.isArray(record.source_objects) ? record.source_objects : [];
    for (const object of objects) {
      const connector = asRecord(asRecord(object)?.connector);
      if (!connector) continue;
      const name = asString(connector.display_name) ?? asString(connector.provider);
      if (name) return name;
    }
  }
  return undefined;
}

function hasCitation(citations: unknown): boolean {
  return Array.isArray(citations) && citations.length > 0;
}

/** Collapse a passage to a single readable line. */
function tidyExcerpt(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  return text.replace(/\s+/g, " ").trim() || undefined;
}

export function parseLegalMemorySources(output: unknown): LegalMemorySourceList | null {
  const hits = coerceHits(output);
  if (!hits) return null;

  const seen = new Set<string>();
  const sources: LegalMemorySource[] = [];
  for (const hit of hits) {
    const record = asRecord(hit);
    const documentId = record ? asString(record.document_id) : undefined;
    if (!record || !documentId) continue;
    if (!hasCitation(record.citations)) continue;
    // Chunk-level search returns several hits per document; the source list is
    // about documents, so the best-ranked hit for each one wins.
    if (seen.has(documentId)) continue;
    seen.add(documentId);
    sources.push({
      documentId,
      title: asString(record.title) ?? documentId,
      docType: asString(record.doc_type_label) ?? asString(record.doc_type),
      versionStatus: asString(record.version_status),
      system: systemOf(record.citations),
      excerpt: tidyExcerpt(record.excerpt),
    });
  }

  return sources.length ? { sources } : null;
}

/** Statuses the appliance treats as an authoritative version. Rendered as a
 * badge so a draft is never mistaken for the operative document. */
const FINAL_STATUSES = new Set(["executed", "final", "signed"]);

export function isAuthoritativeStatus(status: string | undefined): boolean {
  return status ? FINAL_STATUSES.has(status.toLowerCase()) : false;
}
