/**
 * Thin localStorage wrapper for the React shell's "remember what the user had
 * open" behavior. Keys mirror those the Solid app used so users don't lose
 * their spot when switching between shells during the port.
 */

const ACTIVE_WORKSPACE_KEY = "legalwork.react.activeWorkspace";
const LAST_PROJECT_KEY = "legalwork.react.lastProject";
const SESSION_BY_WORKSPACE_KEY = "legalwork.react.sessionByWorkspace";
const WORKSPACE_ORDER_KEY = "legalwork.react.workspaceOrder";

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null || value === "") {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage errors (quota, privacy modes, etc.)
  }
}

export function readActiveWorkspaceId(): string | null {
  const value = safeGet(ACTIVE_WORKSPACE_KEY);
  return value?.trim() || null;
}

export function writeActiveWorkspaceId(id: string | null): void {
  safeSet(ACTIVE_WORKSPACE_KEY, id?.trim() || null);
}

export function readLastProjectId(): string | null {
  return safeGet(LAST_PROJECT_KEY)?.trim() || null;
}

export function writeLastProjectId(id: string | null): void {
  safeSet(LAST_PROJECT_KEY, id?.trim() || null);
}

export function readWorkspaceOrderIds(): string[] {
  const raw = safeGet(WORKSPACE_ORDER_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed ? [trimmed] : [];
    });
  } catch {
    return [];
  }
}

export function writeWorkspaceOrderIds(ids: string[]): void {
  const normalized = ids.flatMap((id) => {
    const trimmed = id.trim();
    return trimmed ? [trimmed] : [];
  });
  safeSet(WORKSPACE_ORDER_KEY, normalized.length ? JSON.stringify(normalized) : null);
}

type SessionByWorkspace = Record<string, string>;

function readSessionByWorkspaceMap(): SessionByWorkspace {
  const raw = safeGet(SESSION_BY_WORKSPACE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: SessionByWorkspace = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof key === "string" && typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    }
  } catch {
    // ignore malformed payload
  }
  return {};
}

export function readLastSessionFor(workspaceId: string): string | null {
  const id = workspaceId?.trim();
  if (!id) return null;
  return readSessionByWorkspaceMap()[id] ?? null;
}

export function writeLastSessionFor(workspaceId: string, sessionId: string | null): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readSessionByWorkspaceMap();
  const normalized = sessionId?.trim() || "";
  if (!normalized) {
    if (!(wsId in map)) return;
    delete map[wsId];
  } else {
    if (map[wsId] === normalized) return;
    map[wsId] = normalized;
  }
  safeSet(SESSION_BY_WORKSPACE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

export function forgetWorkspaceMemory(workspaceId: string): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readSessionByWorkspaceMap();
  if (wsId in map) {
    delete map[wsId];
    safeSet(SESSION_BY_WORKSPACE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
  }
  const active = readActiveWorkspaceId();
  if (active === wsId) writeActiveWorkspaceId(null);
  if (readLastProjectId() === wsId) writeLastProjectId(null);
  const workspaceOrderIds = readWorkspaceOrderIds();
  if (workspaceOrderIds.includes(wsId)) {
    writeWorkspaceOrderIds(workspaceOrderIds.filter((id) => id !== wsId));
  }
}

/** The global Wiki entry restores its own selection, independently of projects. */
export function readLastWikiWorkspaceId(serverUrl: string): string | null {
  return safeGet(`legalwork.wiki.workspace.${serverUrl}`);
}

export function writeLastWikiWorkspaceId(serverUrl: string, id: string): void {
  safeSet(`legalwork.wiki.workspace.${serverUrl}`, id);
}

export function readWikiNavigationWidth(workspaceId: string): number {
  const width = Number(safeGet(`legalwork.wiki.navigationWidth.${workspaceId}`));
  return Number.isFinite(width) && width >= 200 && width <= 440 ? width : 260;
}

export function readWikiNavigationOpen(workspaceId: string): boolean {
  return safeGet(`legalwork.wiki.navigationOpen.${workspaceId}`) !== "false";
}

export function writeWikiNavigationOpen(workspaceId: string, open: boolean): void {
  safeSet(`legalwork.wiki.navigationOpen.${workspaceId}`, String(open));
}

export function writeWikiNavigationWidth(workspaceId: string, width: number): void {
  if (Number.isFinite(width) && width >= 200 && width <= 440) safeSet(`legalwork.wiki.navigationWidth.${workspaceId}`, String(Math.round(width)));
}
