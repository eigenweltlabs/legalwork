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
  return [
    process.env.LEGALWORK_UI_CONTROL_DISCOVERY?.trim(),
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

export async function uiBridgeRequest(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
  const bridge = await discoverUiBridge();
  if (!bridge) return { ok: false, error: "LegalWork UI bridge not available. The desktop app may not be running." };
  try {
    const response = await fetch(`${bridge.baseUrl}${path}`, {
      method: options.method || "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? BRIDGE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${response.status}` }; }
  } catch (error) {
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
  format: "docx" | "xlsx" | "pptx" | "md";
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

export function inAppDocumentSurface(payload: unknown, sessionId?: string): InAppDocumentSurface | null {
  if (typeof payload !== "object" || payload === null) return null;
  const surface = Reflect.get(payload, "activeSurface");
  if (typeof surface !== "object" || surface === null) return null;
  const format = getStringProperty(surface, "format");
  if (getStringProperty(surface, "kind") !== "document" || (format !== "docx" && format !== "xlsx" && format !== "pptx" && format !== "md")) return null;
  const surfaceSessionId = getStringProperty(surface, "sessionId");
  const name = getStringProperty(surface, "name");
  const path = getStringProperty(surface, "path");
  if (!surfaceSessionId || !name || !path || (sessionId && !documentMatchesSession(surface, sessionId))) return null;
  return {
    format,
    sessionId: surfaceSessionId,
    name,
    path,
    editable: getBooleanProperty(surface, "editable") === true,
    agentEditsTracked: getBooleanProperty(surface, "agentEditsTracked") === true,
  };
}

