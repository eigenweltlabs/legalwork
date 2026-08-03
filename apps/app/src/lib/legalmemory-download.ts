/**
 * The export link in a LegalMemory `download_document` result.
 *
 * The tool answers with structured metadata, a text line, and a resource link,
 * and which of those reaches the renderer depends on how the engine serializes
 * MCP tool content. Rather than betting on one shape, look for the link in all
 * of them and give up quietly if it is not there.
 *
 * Nothing here decides whether the link may be fetched. That judgement belongs
 * to the server, which checks it against the firm's configured appliance
 * origins; the app only has to find it.
 */

export type LegalMemoryDownload = {
  url: string;
  filename: string;
  sizeBytes?: number;
};

/** Matches the appliance download route on any host. */
const DOWNLOAD_URL = /https?:\/\/[^\s"'<>)\]]+\/api\/downloads\/[A-Za-z0-9._~-]{16,}\/[^\s"'<>)\]]+/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function filenameFromUrl(url: string): string | null {
  const segment = url.split("/").pop();
  if (!segment) return null;
  try {
    return decodeURIComponent(segment) || null;
  } catch {
    return segment;
  }
}

/** Depth-limited walk for a download_url anywhere in a structured payload. */
function findInObject(value: unknown, depth = 0): LegalMemoryDownload | null {
  if (depth > 4) return null;
  const record = asRecord(value);
  if (record) {
    const direct = record.download_url ?? record.uri;
    if (typeof direct === "string" && DOWNLOAD_URL.test(direct)) {
      const url = DOWNLOAD_URL.exec(direct)![0];
      const filename =
        (typeof record.filename === "string" && record.filename.trim() ? record.filename.trim() : null) ??
        (typeof record.name === "string" && record.name.trim() ? record.name.trim() : null) ??
        filenameFromUrl(url);
      if (filename) {
        const size = record.size_bytes ?? record.size;
        return { url, filename, sizeBytes: typeof size === "number" ? size : undefined };
      }
    }
    for (const nested of Object.values(record)) {
      const found = findInObject(nested, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findInObject(entry, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function parseLegalMemoryDownload(output: unknown): LegalMemoryDownload | null {
  if (typeof output === "string") {
    // Structured JSON first; the text line is the fallback.
    try {
      const parsed: unknown = JSON.parse(output);
      const found = findInObject(parsed);
      if (found) return found;
    } catch {
      // Not JSON, fall through to the text scan.
    }
    const match = DOWNLOAD_URL.exec(output);
    if (!match) return null;
    const filename = filenameFromUrl(match[0]);
    return filename ? { url: match[0], filename } : null;
  }
  return findInObject(output);
}

export function formatExportSize(bytes: number | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
