/**
 * Shared helpers for the Office tool plugins (legalwork-word-tools,
 * legalwork-excel-tools). Each plugin is bundled standalone by `bun build`,
 * so this module is inlined into every plugin bundle.
 *
 * Execution path for all Office tools: tool call -> legalwork-server relay
 * (/workspace/:id/office-tools/execute) -> the Office task pane long-polling
 * that relay -> Office.js -> result back through the same chain.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
  ask?: (input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }) => Promise<void>;
};

export const OFFICE_TOOL_TIMEOUT_MS = 45_000;
const WORKSPACE_CACHE_MS = 10_000;
const PANE_STATUS_CACHE_MS = 5_000;

export function serverUrl(): string {
  return String(process.env.LEGALWORK_SERVER_URL || "").replace(/\/$/, "");
}

export function serverToken(): string {
  return String(process.env.LEGALWORK_SERVER_TOKEN || "");
}

type WorkspaceListPayload = {
  items?: Array<{ id?: unknown; path?: unknown }>;
};

// Keyed by server URL: the cached ids belong to one server, so an engine
// pointed at a different LegalWork server must not read the previous one's.
let workspaceCache: { at: number; url: string; items: Array<{ id: string; path: string }> } | null = null;

export async function listWorkspaces(): Promise<Array<{ id: string; path: string }>> {
  const url = serverUrl();
  if (workspaceCache && workspaceCache.url === url && Date.now() - workspaceCache.at < WORKSPACE_CACHE_MS) {
    return workspaceCache.items;
  }
  const response = await fetch(`${url}/workspaces`, {
    headers: { Authorization: `Bearer ${serverToken()}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Workspace lookup failed: HTTP ${response.status}`);
  const payload = (await response.json()) as WorkspaceListPayload;
  const items = (payload.items ?? []).flatMap((item) =>
    typeof item.id === "string" && typeof item.path === "string" ? [{ id: item.id, path: item.path }] : [],
  );
  workspaceCache = { at: Date.now(), url, items };
  return items;
}

export async function resolveWorkspaceId(context: OpenCodeContext, options: { requireDirectory?: boolean } = {}): Promise<string> {
  const directory = context.directory?.trim() ?? "";
  const items = await listWorkspaces();
  if (directory) {
    const match = [...items].sort((a, b) => b.path.length - a.path.length).find((item) => {
      if (!item.path) return false;
      const path = relative(resolve(item.path), resolve(directory));
      return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
    });
    if (match) return match.id;
  }
  if (!options.requireDirectory && items.length === 1) return items[0]!.id;
  throw new Error(
    directory
      ? `No LegalWork workspace matches the working directory ${directory}.`
      : "Cannot determine the LegalWork workspace for this session.",
  );
}

export async function callOfficeTool(
  context: OpenCodeContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const url = serverUrl();
    const token = serverToken();
    if (!url || !token) {
      return JSON.stringify({ ok: false, error: "LegalWork server connection is not configured for this engine." });
    }
    const workspaceId = await resolveWorkspaceId(context);
    const response = await fetch(`${url}/workspace/${encodeURIComponent(workspaceId)}/office-tools/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool, args, timeoutMs: OFFICE_TOOL_TIMEOUT_MS }),
      signal: AbortSignal.timeout(OFFICE_TOOL_TIMEOUT_MS + 10_000),
    });
    const text = await response.text();
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return JSON.stringify({ ok: false, error: text || `HTTP ${response.status}` });
    }
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export type OfficePaneInfo = {
  /** Lowercased Office host name reported by the pane ("word", "excel", "powerpoint"). */
  host: string;
  documentUrl: string | null;
};

export type OfficePaneStatus = {
  connected: boolean;
  /** One entry per connected pane — Word and Excel can be open at once. */
  hosts: OfficePaneInfo[];
  /** The server could not be asked: unknown, not disconnected. */
  failed?: true;
};

const paneStatusCache = new Map<string, { at: number; status: OfficePaneStatus }>();

/**
 * Status of the connected Office panes, if any. Checked on each user message
 * and tool result (with a short cache) so a reminder switches the agent to
 * document-first behavior as soon as the user opens a pane in an Office host.
 */
export async function officePaneStatus(directory?: string): Promise<OfficePaneStatus> {
  const normalizedDirectory = directory?.trim() ?? "";
  const cacheKey = normalizedDirectory || "*";
  const cached = paneStatusCache.get(cacheKey);
  // A disconnected result can become stale as soon as an Office pane starts
  // polling. Cache only positive detection so a just-opened pane is visible to
  // the next system transform or safety check immediately.
  if (
    cached?.status.connected &&
    Date.now() - cached.at < PANE_STATUS_CACHE_MS
  ) {
    return cached.status;
  }
  let status: OfficePaneStatus = { connected: false, hosts: [] };
  try {
    const url = serverUrl();
    const token = serverToken();
    if (url && token) {
      const items = await listWorkspaces();
      const candidates = normalizedDirectory
        ? items.filter(
            (item) =>
              item.path === normalizedDirectory ||
              normalizedDirectory.startsWith(`${item.path}/`),
          )
        : items.slice(0, 5);
      for (const item of candidates) {
        const response = await fetch(
          `${url}/workspace/${encodeURIComponent(item.id)}/office-tools/status`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) },
        );
        if (!response.ok) {
          status = { connected: false, hosts: [], failed: true };
          continue;
        }
        const payload = (await response.json()) as {
          connected?: unknown;
          hosts?: unknown;
        };
        if (payload.connected === true && Array.isArray(payload.hosts)) {
          const hosts = payload.hosts.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const host = (entry as { host?: unknown }).host;
            const documentUrl = (entry as { documentUrl?: unknown }).documentUrl;
            return typeof host === "string" && host
              ? [{ host: host.toLowerCase(), documentUrl: typeof documentUrl === "string" && documentUrl ? documentUrl : null }]
              : [];
          });
          if (hosts.length > 0) {
            status = { connected: true, hosts };
            break;
          }
        }
      }
    }
  } catch {
    status = { connected: false, hosts: [], failed: true };
  }
  paneStatusCache.set(cacheKey, { at: Date.now(), status });
  return status;
}

/** The connected pane for a specific host, if any. */
export async function officePaneForHost(host: string, directory?: string): Promise<OfficePaneInfo | null> {
  const status = await officePaneStatus(directory);
  return status.hosts.find((entry) => entry.host === host) ?? null;
}

/** The connected pane for a host, null without one, undefined when the server could not be asked. */
export async function officePaneIfKnown(host: string, directory?: string): Promise<OfficePaneInfo | null | undefined> {
  const status = await officePaneStatus(directory);
  return status.failed ? undefined : status.hosts.find((entry) => entry.host === host) ?? null;
}

export function describeOpenDocument(documentUrl: string | null): string {
  if (!documentUrl) {
    return "The open document has not been saved yet (untitled).";
  }
  const name = documentUrl.split(/[\\/]/).pop() || documentUrl;
  return `The open document is "${name}" (${documentUrl}).`;
}
