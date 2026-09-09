import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from "../provider-config.js";
import type { MailOAuthSettings } from "../providers/oauth.js";
import type { MailConnectionStatus } from "../providers/connection-controller.js";
/** Private parent/worker protocol. No public SQL, filesystem or network command surface. */
export const MAIL_WORKER_PROTOCOL = 1;
export const MAX_WORKER_MESSAGE_BYTES = 64 * 1024;
export const MAX_WORKER_PAGE_SIZE = 100;

export type WorkerCredentials = {
  accountId: string;
  provider: "gmail" | "graph";
  accessToken?: string;
  refreshToken?: string;
};
/** Trusted startup-only identity and configuration. Never populated from HTTP request bodies. */
export type WorkerInitialization = {
  ownerId?: string;
  databasePath?: string;
  /** Canonical base64 of exactly 32 bytes. Required by the production worker. */
  encryptionKey?: string;
  /** Reserved for future provider integration; production currently rejects nonempty credentials. */
  credentials?: WorkerCredentials[];
};
type Page = { limit?: number; after?: string };
export type WorkerCommand =
  | { operation: "ping" }
  | { operation: "mail.storage.status" }
  | { operation: "mail.connection.begin"; settings: MailOAuthSettings; reconnectAccountId?: string }
  | { operation: "mail.connection.poll"; connectionId: string }
  | { operation: "mail.connection.cancel"; connectionId: string }
  | { operation: "mail.account.disconnect"; accountId: string }
  | ({ operation: "mail.accounts.list" } & Page)
  | ({ operation: "mail.folders.list"; accountId: string } & Page)
  | { operation: "mail.status"; accountId: string }
  | { operation: "mail.sync.start"; accountId: string }
  | { operation: "mail.sync.stop"; accountId: string }
  | { operation: "credentials.update"; credentials: WorkerCredentials };

export type WorkerAccount = { id: string; provider: "gmail" | "graph" | "imap"; displayName: string };
export type WorkerFolder = { id: string; name: string; kind: "folder" | "label"; parentId: string | null };
export type WorkerResult =
  | { pong: true }
  | { connectionStarted: { connectionId: string; authorizationUrl: string; expiresAt: number } }
  | { connection: MailConnectionStatus }
  | { cancelled: true }
  | { disconnected: true }
  | { state: "idle" | "syncing"; syncSupported: boolean }
  | { encrypted: true; schemaVersion: number; syncSupported: false }
  | { accounts: WorkerAccount[]; nextCursor: string | null }
  | { folders: WorkerFolder[]; nextCursor: string | null }
  | { accepted: true }
  | { updated: true };
export type WorkerErrorCode = "locked" | "not_ready" | "unsupported" | "operation_failed" | "not_found" | "response_too_large";
export type ParentMessage =
  | { kind: "initialize"; protocol: 1; initialization: WorkerInitialization }
  | { kind: "request"; id: string; command: WorkerCommand }
  | { kind: "shutdown" };
export type WorkerMessage =
  | { kind: "ready"; protocol: 1; runtime: "node"; nodeVersion: string }
  | { kind: "fatal"; code: "initialization_failed" | "protocol_error" }
  | { kind: "response"; id: string; ok: true; result: WorkerResult }
  | { kind: "response"; id: string; ok: false; code: WorkerErrorCode };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096; }
function cursor(value: unknown): value is string | null { return value === null || id(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function time(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function mailScopes(value: unknown, provider: "gmail" | "graph"): value is string[] {
  const expected = provider === "gmail" ? GMAIL_MAIL_SCOPES : GRAPH_MAIL_SCOPES;
  return Array.isArray(value) && value.length === expected.length && new Set(value).size === value.length && value.every(scope => expected.includes(scope));
}
/** Settings are a trusted parent-only transport; no endpoint, fetch, owner, token or redirect overrides. */
function settings(value: unknown): value is MailOAuthSettings {
  if (!record(value) || value.applicationType !== "desktop" || value.pkceMethod !== "S256") return false;
  if (value.provider === "gmail") return exact(value, ["provider", "applicationType", "pkceMethod", "clientId", "clientSecret", "scopes"])
    && typeof value.clientId === "string" && value.clientId.length <= 4096 && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId)
    && typeof value.clientSecret === "string" && /^[\x21-\x7e]{1,16384}$/.test(value.clientSecret) && mailScopes(value.scopes, "gmail");
  return value.provider === "graph" && exact(value, ["provider", "applicationType", "pkceMethod", "clientId", "tenantId", "registeredRedirectUri", "scopes"])
    && uuid(value.clientId) && uuid(value.tenantId) && value.registeredRedirectUri === "http://localhost/mail/callback" && mailScopes(value.scopes, "graph");
}
/** Browser-target allowlist, including exact query keys, S256/state shape and loopback callback. */
function authorizationUrl(value: unknown, expected?: MailOAuthSettings): boolean {
  if (typeof value !== "string" || value.length > 16384 || value.includes("\\")) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false;
    const google = url.hostname === "accounts.google.com" && url.pathname === "/o/oauth2/v2/auth";
    const graph = url.hostname === "login.microsoftonline.com" && /^\/[0-9a-f-]{36}\/oauth2\/v2\.0\/authorize$/i.test(url.pathname) && uuid(url.pathname.split("/")[1]);
    if (!google && !graph) return false;
    const provider = google ? "gmail" : "graph";
    const keys = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", ...(google ? ["access_type", "prompt"] : ["response_mode"])];
    if ([...url.searchParams.keys()].length !== keys.length || keys.some(key => url.searchParams.getAll(key).length !== 1)) return false;
    const clientId = url.searchParams.get("client_id") ?? "";
    if (google ? !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) : !uuid(clientId)) return false;
    if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256"
      || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "")
      || !mailScopes((url.searchParams.get("scope") ?? "").split(" "), provider)) return false;
    if (google ? url.searchParams.get("access_type") !== "offline" || url.searchParams.get("prompt") !== "consent" : url.searchParams.get("response_mode") !== "query") return false;
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    if (!(google ? /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/ : /^http:\/\/localhost:[1-9][0-9]{0,4}\/mail\/callback$/).test(redirect)) return false;
    const callback = new URL(redirect);
    if (!callback.port) return false;
    return !expected || (expected.provider === provider && expected.clientId === clientId
      && (expected.provider !== "graph" || expected.tenantId.toLowerCase() === url.pathname.split("/")[1]?.toLowerCase()));
  } catch { return false; }
}
const connectionErrors = ["configuration_invalid", "provider_busy", "capacity", "closed", "not_found", "account_not_found", "reconnect_required", "binding_mismatch", "stale_credentials", "permissions_missing", "cancelled", "expired", "authorization_failed", "identity_failed", "persistence_failed"];
function connection(value: unknown): value is MailConnectionStatus {
  if (!record(value) || !uuid(value.connectionId) || !time(value.expiresAt)) return false;
  if (value.state === "connected") return exact(value, ["connectionId", "expiresAt", "state", "accountId", "renewable"]) && id(value.accountId) && typeof value.renewable === "boolean";
  if (value.state === "failed") return exact(value, ["connectionId", "expiresAt", "state", "error"]) && typeof value.error === "string" && connectionErrors.includes(value.error);
  return exact(value, ["connectionId", "expiresAt", "state"]) && typeof value.state === "string" && ["pending", "verifying", "cancelled", "expired"].includes(value.state);
}
function started(value: unknown): boolean {
  return record(value) && exact(value, ["connectionId", "authorizationUrl", "expiresAt"]) && uuid(value.connectionId) && time(value.expiresAt) && authorizationUrl(value.authorizationUrl);
}
function account(value: unknown): value is WorkerAccount {
  return record(value) && exact(value, ["id", "provider", "displayName"]) && id(value.id)
    && (value.provider === "gmail" || value.provider === "graph" || value.provider === "imap") && typeof value.displayName === "string";
}
function folder(value: unknown): value is WorkerFolder {
  return record(value) && exact(value, ["id", "name", "kind", "parentId"]) && id(value.id)
    && typeof value.name === "string" && (value.kind === "folder" || value.kind === "label") && cursor(value.parentId);
}
function result(value: unknown): value is WorkerResult {
  return record(value) && ((exact(value, ["pong"]) && value.pong === true)
    || (exact(value, ["connectionStarted"]) && started(value.connectionStarted))
    || (exact(value, ["connection"]) && connection(value.connection))
    || (exact(value, ["cancelled"]) && value.cancelled === true)
    || (exact(value, ["disconnected"]) && value.disconnected === true)
    || (exact(value, ["state", "syncSupported"]) && (value.state === "idle" || value.state === "syncing") && typeof value.syncSupported === "boolean")
    || (exact(value, ["encrypted", "schemaVersion", "syncSupported"]) && value.encrypted === true && value.syncSupported === false && Number.isSafeInteger(value.schemaVersion) && typeof value.schemaVersion === "number" && value.schemaVersion > 0)
    || (exact(value, ["accounts", "nextCursor"]) && Array.isArray(value.accounts) && value.accounts.length <= MAX_WORKER_PAGE_SIZE && value.accounts.every(account) && cursor(value.nextCursor))
    || (exact(value, ["folders", "nextCursor"]) && Array.isArray(value.folders) && value.folders.length <= MAX_WORKER_PAGE_SIZE && value.folders.every(folder) && cursor(value.nextCursor))
    || (exact(value, ["accepted"]) && value.accepted === true)
    || (exact(value, ["updated"]) && value.updated === true));
}
export function parseWorkerMessage(line: string): WorkerMessage | undefined {
  if (Buffer.byteLength(line) > MAX_WORKER_MESSAGE_BYTES) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!record(value)) return;
  if (exact(value, ["kind", "protocol", "runtime", "nodeVersion"]) && value.kind === "ready"
    && value.protocol === 1 && value.runtime === "node" && typeof value.nodeVersion === "string" && value.nodeVersion.length <= 32
    && /^\d+\.\d+\.\d+$/.test(value.nodeVersion)) {
    return { kind: "ready", protocol: 1, runtime: "node", nodeVersion: value.nodeVersion };
  }
  if (exact(value, ["kind", "code"]) && value.kind === "fatal" && (value.code === "initialization_failed" || value.code === "protocol_error")) return { kind: "fatal", code: value.code };
  if (value.kind !== "response" || typeof value.id !== "string" || value.id.length > 40 || !/^[0-9]+:[0-9]+$/.test(value.id)) return;
  if (exact(value, ["kind", "id", "ok", "result"]) && value.ok === true && result(value.result)) return { kind: "response", id: value.id, ok: true, result: value.result };
  if (exact(value, ["kind", "id", "ok", "code"]) && value.ok === false
    && (value.code === "locked" || value.code === "not_ready" || value.code === "unsupported" || value.code === "operation_failed" || value.code === "not_found" || value.code === "response_too_large")) {
    return { kind: "response", id: value.id, ok: false, code: value.code };
  }
}
export function resultMatchesCommand(command: WorkerCommand, value: WorkerResult): boolean {
  switch (command.operation) {
    case "ping": return "pong" in value;
    case "mail.connection.begin": return "connectionStarted" in value && authorizationUrl(value.connectionStarted.authorizationUrl, command.settings);
    case "mail.connection.poll": return "connection" in value && value.connection.connectionId === command.connectionId;
    case "mail.connection.cancel": return "cancelled" in value;
    case "mail.account.disconnect": return "disconnected" in value;
    case "mail.storage.status": return "encrypted" in value;
    case "mail.accounts.list": return "accounts" in value;
    case "mail.folders.list": return "folders" in value;
    case "mail.status": return "state" in value;
    case "credentials.update": return "updated" in value;
    case "mail.sync.start":
    case "mail.sync.stop": return "accepted" in value;
  }
}
export function validWorkerCommand(value: unknown): value is WorkerCommand {
  if (!record(value)) return false;
  if (value.operation === "mail.connection.begin") return Object.keys(value).every(key => ["operation", "settings", "reconnectAccountId"].includes(key))
    && settings(value.settings) && (!Object.hasOwn(value, "reconnectAccountId") || id(value.reconnectAccountId));
  if (value.operation === "mail.connection.poll" || value.operation === "mail.connection.cancel") return exact(value, ["operation", "connectionId"]) && uuid(value.connectionId);
  if (value.operation === "mail.account.disconnect") return exact(value, ["operation", "accountId"]) && id(value.accountId);
  if (value.operation === "ping" || value.operation === "mail.storage.status") return exact(value, ["operation"]);
  if (value.operation === "credentials.update") {
    const credentials = value.credentials;
    return exact(value, ["operation", "credentials"]) && record(credentials)
      && Object.keys(credentials).every((key) => ["accountId", "provider", "accessToken", "refreshToken"].includes(key))
      && id(credentials.accountId) && (credentials.provider === "gmail" || credentials.provider === "graph")
      && (credentials.accessToken === undefined || typeof credentials.accessToken === "string")
      && (credentials.refreshToken === undefined || typeof credentials.refreshToken === "string");
  }
  if (value.operation === "mail.accounts.list" || value.operation === "mail.folders.list") {
    const allowed = value.operation === "mail.accounts.list" ? ["operation", "limit", "after"] : ["operation", "accountId", "limit", "after"];
    return Object.keys(value).every((key) => allowed.includes(key))
      && (value.operation !== "mail.folders.list" || id(value.accountId))
      && (value.after === undefined || id(value.after))
      && (value.limit === undefined || (typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= MAX_WORKER_PAGE_SIZE));
  }
  return typeof value.operation === "string" && ["mail.status", "mail.sync.start", "mail.sync.stop"].includes(value.operation)
    && exact(value, ["operation", "accountId"]) && id(value.accountId);
}
/** Worker-side parser; bound bytes before accumulating/decoding input as well. */
export function parseParentMessage(line: string): ParentMessage | undefined {
  if (Buffer.byteLength(line) > MAX_WORKER_MESSAGE_BYTES) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!record(value)) return;
  if (exact(value, ["kind"]) && value.kind === "shutdown") return { kind: "shutdown" };
  if (exact(value, ["kind", "id", "command"]) && value.kind === "request"
    && typeof value.id === "string" && value.id.length <= 40 && /^[0-9]+:[0-9]+$/.test(value.id)
    && validWorkerCommand(value.command)) return { kind: "request", id: value.id, command: value.command };
  if (!exact(value, ["kind", "protocol", "initialization"]) || value.kind !== "initialize" || value.protocol !== 1 || !record(value.initialization)) return;
  const input = value.initialization;
  if (!Object.keys(input).every((key) => ["ownerId", "databasePath", "encryptionKey", "credentials"].includes(key))) return;
  const initialization: WorkerInitialization = {};
  if (Object.hasOwn(input, "ownerId")) { if (!id(input.ownerId)) return; initialization.ownerId = input.ownerId; }
  if (Object.hasOwn(input, "databasePath")) { if (typeof input.databasePath !== "string") return; initialization.databasePath = input.databasePath; }
  if (Object.hasOwn(input, "encryptionKey")) { if (typeof input.encryptionKey !== "string") return; initialization.encryptionKey = input.encryptionKey; }
  if (Object.hasOwn(input, "credentials")) {
    if (!Array.isArray(input.credentials) || input.credentials.length > 100) return;
    initialization.credentials = [];
    for (const credentials of input.credentials) {
      const command: unknown = { operation: "credentials.update", credentials };
      if (!validWorkerCommand(command) || command.operation !== "credentials.update") return;
      initialization.credentials.push(command.credentials);
    }
  }
  return { kind: "initialize", protocol: 1, initialization };
}
