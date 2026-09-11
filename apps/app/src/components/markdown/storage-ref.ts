/**
 * Connected-storage references in chat text.
 *
 * The sibling of legalmemory-ref.ts. A storage object has no LegalMemory
 * document id, so it is addressed by its connection plus the path inside that
 * connection:
 *
 *   [competitor-identification-chart.xlsx](legalworkstorage://<connectionId>/<path>?name=&path=)
 *
 * The `path` query carries the workspace-relative copy the app checked out
 * before the mention was inserted, so a chip can open it without another
 * round-trip. It is metadata on the pill, never a binary chat attachment.
 */

export const STORAGE_OPEN_EVENT = "legalwork:storage-open";

export type StorageRef = {
  connectionId: string;
  /** Path inside the connected storage root, not a workspace path. */
  path: string;
  label: string;
  /** Workspace-relative location of the checked-out copy, when present. */
  localPath?: string;
  /** Canonical form with no query, for display and comparison. */
  uri: string;
};

const STORAGE_REF = /^legalworkstorage:\/{0,2}([^/\s?]+)\/([^?\s]+)(?:\?([^\s]*))?$/i;

/** Matches a full `[label](legalworkstorage://...)` markdown link. */
export const STORAGE_LINK_SOURCE = String.raw`\[[^\]\n]+\]\(legalworkstorage:\/\/[^\s)]+\)`;

export function buildStorageRefUri(connectionId: string, path: string, label?: string, localPath?: string): string {
  const base = `legalworkstorage://${encodeURIComponent(connectionId)}/${encodeURIComponent(path)}`;
  const params = new URLSearchParams();
  if (label?.trim()) params.set("name", label.trim());
  if (localPath?.trim()) params.set("path", localPath.trim());
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function parseStorageRef(href: string): StorageRef | null {
  const match = STORAGE_REF.exec(href.trim());
  if (!match?.[1] || !match?.[2]) return null;
  try {
    const connectionId = decodeURIComponent(match[1]);
    const path = decodeURIComponent(match[2]);
    if (!connectionId || !path) return null;
    const params = new URLSearchParams(match[3] ?? "");
    const label = (params.get("name") ?? path).trim() || path;
    const localPath = params.get("path")?.trim() || undefined;
    return {
      connectionId,
      path,
      label,
      ...(localPath ? { localPath } : {}),
      uri: `legalworkstorage://${encodeURIComponent(connectionId)}/${encodeURIComponent(path)}`,
    };
  } catch {
    return null;
  }
}

/** Parses the `[label](legalworkstorage://...)` link a user turn persists. */
export function parseStorageRefLink(segment: string): StorageRef | null {
  const match = /^\[([^\]\n]+)\]\((legalworkstorage:\/\/[^\s)]+)\)$/.exec(segment.trim());
  if (!match?.[1] || !match?.[2]) return null;
  const ref = parseStorageRef(match[2]);
  if (!ref) return null;
  return { ...ref, label: match[1].trim() || ref.label };
}
