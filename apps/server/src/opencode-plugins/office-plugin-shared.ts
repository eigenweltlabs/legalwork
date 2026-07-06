/**
 * Shared helpers for the Office tool plugins (legalwork-word-tools,
 * legalwork-excel-tools). Each plugin is bundled standalone by `bun build`,
 * so this module is inlined into every plugin bundle.
 *
 * Execution path for all Office tools: tool call -> legalwork-server relay
 * (/workspace/:id/office-tools/execute) -> the Office task pane long-polling
 * that relay -> Office.js -> result back through the same chain.
 */

export type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
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

let workspaceCache: { at: number; items: Array<{ id: string; path: string }> } | null = null;

export async function listWorkspaces(): Promise<Array<{ id: string; path: string }>> {
  if (workspaceCache && Date.now() - workspaceCache.at < WORKSPACE_CACHE_MS) return workspaceCache.items;
  const response = await fetch(`${serverUrl()}/workspaces`, {
    headers: { Authorization: `Bearer ${serverToken()}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Workspace lookup failed: HTTP ${response.status}`);
  const payload = (await response.json()) as WorkspaceListPayload;
  const items = (payload.items ?? []).flatMap((item) =>
    typeof item.id === "string" && typeof item.path === "string" ? [{ id: item.id, path: item.path }] : [],
  );
  workspaceCache = { at: Date.now(), items };
  return items;
}

export async function resolveWorkspaceId(context: OpenCodeContext): Promise<string> {
  const directory = context.directory?.trim() ?? "";
  const items = await listWorkspaces();
  if (directory) {
    const match =
      items.find((item) => item.path === directory) ??
      items.find((item) => directory.startsWith(`${item.path}/`));
    if (match) return match.id;
  }
  if (items.length === 1) return items[0]!.id;
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
};

let paneStatusCache: { at: number; status: OfficePaneStatus } | null = null;

/**
 * Status of the connected Office panes, if any. Checked per chat turn (with
 * a short cache) so system prompts flip to document-first behavior as soon
 * as the user opens a pane in an Office host.
 */
export async function officePaneStatus(): Promise<OfficePaneStatus> {
  if (paneStatusCache && Date.now() - paneStatusCache.at < PANE_STATUS_CACHE_MS) {
    return paneStatusCache.status;
  }
  let status: OfficePaneStatus = { connected: false, hosts: [] };
  try {
    const url = serverUrl();
    const token = serverToken();
    if (url && token) {
      const items = await listWorkspaces();
      for (const item of items.slice(0, 5)) {
        const response = await fetch(
          `${url}/workspace/${encodeURIComponent(item.id)}/office-tools/status`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) },
        );
        if (!response.ok) continue;
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
    status = { connected: false, hosts: [] };
  }
  paneStatusCache = { at: Date.now(), status };
  return status;
}

/** The connected pane for a specific host, if any. */
export async function officePaneForHost(host: string): Promise<OfficePaneInfo | null> {
  const status = await officePaneStatus();
  return status.hosts.find((entry) => entry.host === host) ?? null;
}

const HOST_LABELS: Record<string, string> = {
  word: "Microsoft Word",
  excel: "Microsoft Excel",
  powerpoint: "Microsoft PowerPoint",
};
const HOST_TOOL_PREFIX: Record<string, string> = {
  word: "word_*",
  excel: "excel_*",
  powerpoint: "ppt_*",
};

/**
 * A prompt fragment naming the OTHER Office apps whose panes are open, so a
 * host-specific mode prompt doesn't tunnel the agent into a single app. Empty
 * when this is the only pane. Appended to each live mode instruction.
 */
export async function describeOtherOpenApps(currentHost: string): Promise<string> {
  const status = await officePaneStatus();
  const others = status.hosts.filter((entry) => entry.host !== currentHost && HOST_LABELS[entry.host]);
  if (others.length === 0) return "";
  const list = others
    .map((entry) => {
      const name = entry.documentUrl ? entry.documentUrl.split(/[\\/]/).pop() || "" : "";
      return `${HOST_LABELS[entry.host]} (${HOST_TOOL_PREFIX[entry.host]} tools${name ? `, "${name}"` : ""})`;
    })
    .join(", ");
  return `\n\nIMPORTANT: other Office apps are open next to this chat and you can use their tools in the SAME conversation: ${list}. Do not restrict yourself to one app — choose tools by which document a request is about. It is expected and correct to read from one app and edit another in a single task (e.g. read a figure from the workbook, then redline the Word document).`;
}

export function describeOpenDocument(documentUrl: string | null): string {
  if (!documentUrl) {
    return "The open document has not been saved yet (untitled).";
  }
  const name = documentUrl.split(/[\\/]/).pop() || documentUrl;
  return `The open document is "${name}" (${documentUrl}).`;
}
