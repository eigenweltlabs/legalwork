/**
 * Exporting an original document out of LegalMemory into the workspace.
 *
 * `download_document` hands back a short-lived URL whose capability token *is*
 * the credential, so the bytes can be fetched with no appliance login. That is
 * what lets the app open a cited source directly instead of asking the agent to
 * shell out to curl and waiting a turn.
 *
 * It also means the URL is worth attacking, and it reaches us out of model
 * output, which is untrusted. So nothing here trusts the caller:
 *
 *   - the origin must be one the firm actually configured a LegalMemory MCP
 *     server for, read from config rather than supplied by the renderer;
 *   - the path must be the download route's exact shape, so a validated origin
 *     cannot be used to pull some other endpoint on the appliance;
 *   - the filename is derived from the validated URL, never passed alongside
 *     it, and is reduced to a bare name so it cannot escape the workspace.
 *
 * The functions are pure so the rules can be tested without an appliance.
 */

/** Server names a firm connects the appliance under: the quick-connect catalog
 * uses "legalmemory", the appliance's own sample config says "knowledge-index". */
const LEGALMEMORY_SERVER_NAME = /^(?:legal[_-]?memory|knowledge[_-]?index)$/i;

/** `/api/downloads/<token>/<url-encoded filename>` and nothing else. */
const DOWNLOAD_PATH = /^\/api\/downloads\/([A-Za-z0-9._~-]{16,})\/([^/]+)$/;

/** Refuse anything a firm would not recognise as one of its own documents. */
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

export type McpConfigLike = { name: string; config?: unknown };

/**
 * Origins the firm has configured a LegalMemory server for.
 *
 * Only these may be fetched. A server that is configured but currently
 * disconnected still counts: the capability token is what authorizes the read,
 * and a link issued moments before a disconnect is still the firm's own
 * document. Nothing else about the entry is trusted.
 */
export function legalMemoryOrigins(items: readonly McpConfigLike[]): Set<string> {
  const origins = new Set<string>();
  for (const item of items) {
    if (!LEGALMEMORY_SERVER_NAME.test(item.name)) continue;
    const config = item.config;
    const url = config && typeof config === "object" && "url" in config ? (config as { url?: unknown }).url : undefined;
    if (typeof url !== "string") continue;
    try {
      origins.add(new URL(url).origin);
    } catch {
      // A malformed configured URL contributes no origin rather than throwing:
      // one bad entry must not stop a second, valid appliance from working.
    }
  }
  return origins;
}

export type ValidatedDownload = {
  url: string;
  filename: string;
};

/**
 * Accept a download URL only if it points at a configured appliance's download
 * route, and derive the export filename from it.
 */
export function validateDownloadUrl(
  rawUrl: unknown,
  allowedOrigins: ReadonlySet<string>,
): ValidatedDownload | null {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  // http is allowed because an on-prem appliance may sit behind an internal
  // TLS-terminating proxy; the origin check is what constrains the target.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!allowedOrigins.has(url.origin)) return null;

  const match = DOWNLOAD_PATH.exec(url.pathname);
  if (!match) return null;

  const filename = safeExportFilename(decodeSegment(match[2]));
  if (!filename) return null;
  // Rebuild from the parsed URL so no query or fragment rides along.
  return { url: `${url.origin}${url.pathname}`, filename };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Reduce a name from the appliance to something that can only ever land
 * directly in the workspace root.
 */
export function safeExportFilename(name: string): string | null {
  // Both separators, whatever the appliance's own platform was.
  const base = name.split(/[/\\]/).pop()?.trim() ?? "";
  if (!base || base === "." || base === "..") return null;
  // Control characters and the Windows-reserved set; a document name should
  // never contain them, and they are how a name becomes something else.
  if (/[\x00-\x1f\x7f<>:"|?*]/.test(base)) return null;
  // A leading dot would hide the export from the workspace listing the user is
  // looking at, which reads as the export having failed.
  if (base.startsWith(".")) return null;
  return base.length > 200 ? base.slice(0, 200) : base;
}

/** Reject an oversized body before it is buffered. Returns the reason, or null
 * when the length is acceptable or simply not advertised. */
export function exportSizeRejection(contentLength: unknown): string | null {
  const declared = typeof contentLength === "string" ? Number(contentLength) : Number.NaN;
  if (!Number.isFinite(declared)) return null;
  return declared > MAX_EXPORT_BYTES
    ? `document is larger than the ${Math.round(MAX_EXPORT_BYTES / (1024 * 1024))} MB export limit`
    : null;
}

export const LEGALMEMORY_MAX_EXPORT_BYTES = MAX_EXPORT_BYTES;
