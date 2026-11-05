import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

// ── UI control bridge discovery ──

type UiBridge = { baseUrl: string; token: string };
let cachedBridge: UiBridge | null = null;
let cachedBridgeAt = 0;
const BRIDGE_CACHE_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;

function userAppDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  if (platform() === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function uiControlDiscoveryPaths(): string[] {
  const explicit = process.env.LEGALWORK_UI_CONTROL_DISCOVERY?.trim();
  if (explicit) return [explicit];
  return [
    join(userAppDataDir(), "com.eigenweltlabs.legalwork", "legalwork-ui-control.json"),
    join(userAppDataDir(), "com.eigenweltlabs.legalwork.dev", "legalwork-ui-control.json"),
  ].filter((p): p is string => Boolean(p));
}

async function discoverUiBridge(): Promise<UiBridge | null> {
  if (cachedBridge && Date.now() - cachedBridgeAt < BRIDGE_CACHE_MS) return cachedBridge;
  for (const candidate of uiControlDiscoveryPaths()) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.token === "string") {
        cachedBridge = { baseUrl: parsed.baseUrl, token: parsed.token };
        cachedBridgeAt = Date.now();
        return cachedBridge;
      }
    } catch {
      // Try next
    }
  }
  return null;
}

export async function uiBridgeRequest(path: string, options: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  options.signal?.throwIfAborted();
  const bridge = await discoverUiBridge();
  if (!bridge) return { ok: false, error: "LegalWork UI bridge not available. The desktop app may not be running." };
  try {
    const response = await fetch(`${bridge.baseUrl}${path}`, {
      method: options.method || "GET",
      signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? BRIDGE_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${response.status}` }; }
  } catch (error) {
    options.signal?.throwIfAborted();
    cachedBridge = null;
    cachedBridgeAt = 0;
    return { ok: false, error: `UI bridge unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function getStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}

export function getBooleanProperty(value: unknown, key: string): boolean | null {
  if (typeof value !== "object" || value === null) return null;
  const property = Reflect.get(value, key);
  return typeof property === "boolean" ? property : null;
}

export type InAppDocumentSurface = {
  format: "docx" | "xlsx" | "pptx" | "md" | "pdf";
  sessionId: string;
  name: string;
  path: string;
  editable: boolean;
  agentEditsTracked: boolean;
};

/** Explicit chat membership takes precedence over the legacy pane/session id. */
export function documentMatchesSession(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object" || !sessionId) return false;
  const sessions: unknown = Reflect.get(value, "sessionIds");
  return sessions === undefined ? getStringProperty(value, "sessionId") === sessionId
    : Array.isArray(sessions) && sessions.includes(sessionId);
}

export function inAppDocumentSurface(payload: unknown, sessionId?: string, path?: string): InAppDocumentSurface | null {
  if (typeof payload !== "object" || payload === null) return null;
  const active: unknown = Reflect.get(payload, "activeSurface");
  const surfaces: unknown = Reflect.get(payload, "surfaces");
  const surface: unknown = path && getStringProperty(active, "path") !== path && Array.isArray(surfaces)
    ? surfaces.find(candidate => getStringProperty(candidate, "path") === path && (!sessionId || documentMatchesSession(candidate, sessionId))) : active;
  if (typeof surface !== "object" || surface === null) return null;
  const format = getStringProperty(surface, "format");
  if (getStringProperty(surface, "kind") !== "document" || (format !== "docx" && format !== "xlsx" && format !== "pptx" && format !== "md" && format !== "pdf")) return null;
  const surfaceSessionId = getStringProperty(surface, "sessionId");
  const name = getStringProperty(surface, "name");
  const surfacePath = getStringProperty(surface, "path");
  if (!surfaceSessionId || !name || !surfacePath || (path && path !== surfacePath) || (sessionId && !documentMatchesSession(surface, sessionId))) return null;
  return {
    format,
    sessionId: surfaceSessionId,
    name,
    path: surfacePath,
    editable: getBooleanProperty(surface, "editable") === true,
    agentEditsTracked: getBooleanProperty(surface, "agentEditsTracked") === true,
  };
}

/** All live drafts protected from file writes, including another chat's drafts. */
export function protectedDocumentSurfaces(payload: unknown, sessionId: string): InAppDocumentSurface[] {
  if (!payload || typeof payload !== "object") return [];
  const protectedSurfaces: unknown = Reflect.get(payload, "protectedSurfaces");
  const surfaces: unknown = Reflect.get(payload, "surfaces");
  const candidates = Array.isArray(protectedSurfaces) ? protectedSurfaces
    : [Reflect.get(payload, "activeSurface"), ...(Array.isArray(surfaces) ? surfaces : [])];
  return candidates.flatMap(activeSurface => {
    const surface = inAppDocumentSurface({ activeSurface }, sessionId);
    return surface ? [surface] : [];
  });
}


/** Task-scoped document inventory, independent of the visible workspace. */
export async function taskDocumentSnapshot(sessionId: string | undefined): Promise<unknown> {
  if (!sessionId) return { ok: false, error: "A task is required." };
  const response = await uiBridgeRequest("/execute", { method: "POST", body: { actionId: "documents.list", args: { sessionId } } });
  if (response && typeof response === "object" && Reflect.get(response, "ok") === true) return Reflect.get(response, "result");
  return response;
}
