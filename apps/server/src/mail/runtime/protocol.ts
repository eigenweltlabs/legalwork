/** Private parent/worker protocol. Extend explicitly when real worker handlers exist. */
export const MAIL_WORKER_PROTOCOL = 1;
export const MAX_WORKER_MESSAGE_BYTES = 64 * 1024;

export type WorkerCredentials = {
  accountId: string;
  provider: "gmail" | "graph";
  accessToken?: string;
  refreshToken?: string;
};

/** Trusted startup configuration, delivered through the private pipe, never command arguments. */
export type WorkerInitialization = {
  databasePath?: string;
  encryptionKey?: string;
  credentials?: WorkerCredentials[];
};

export type WorkerCommand =
  | { operation: "ping" }
  | { operation: "mail.status"; accountId: string }
  | { operation: "mail.sync.start"; accountId: string }
  | { operation: "mail.sync.stop"; accountId: string }
  | { operation: "credentials.update"; credentials: WorkerCredentials };

export type WorkerResult =
  | { pong: true }
  | { state: "idle" | "syncing" }
  | { accepted: true }
  | { updated: true };

export type ParentMessage =
  | { kind: "initialize"; protocol: 1; initialization: WorkerInitialization }
  | { kind: "request"; id: string; command: WorkerCommand }
  | { kind: "shutdown" };

export type WorkerMessage =
  | { kind: "ready"; protocol: 1; runtime: "node"; nodeVersion: string }
  | { kind: "response"; id: string; ok: true; result: WorkerResult }
  | { kind: "response"; id: string; ok: false; code: "not_ready" | "unsupported" | "operation_failed" };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function result(value: unknown): value is WorkerResult {
  return record(value) && ((exact(value, ["pong"]) && value.pong === true)
    || (exact(value, ["state"]) && (value.state === "idle" || value.state === "syncing"))
    || (exact(value, ["accepted"]) && value.accepted === true)
    || (exact(value, ["updated"]) && value.updated === true));
}
export function parseWorkerMessage(line: string): WorkerMessage | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!record(value)) return;
  if (exact(value, ["kind", "protocol", "runtime", "nodeVersion"]) && value.kind === "ready"
    && value.protocol === 1 && value.runtime === "node" && typeof value.nodeVersion === "string" && value.nodeVersion.length <= 32
    && /^\d+\.\d+\.\d+$/.test(value.nodeVersion)) {
    return { kind: "ready", protocol: 1, runtime: "node", nodeVersion: value.nodeVersion };
  }
  if (value.kind !== "response" || typeof value.id !== "string" || value.id.length > 40 || !/^[0-9]+:[0-9]+$/.test(value.id)) return;
  if (exact(value, ["kind", "id", "ok", "result"]) && value.ok === true && result(value.result)) {
    return { kind: "response", id: value.id, ok: true, result: value.result };
  }
  if (exact(value, ["kind", "id", "ok", "code"]) && value.ok === false
    && (value.code === "not_ready" || value.code === "unsupported" || value.code === "operation_failed")) {
    return { kind: "response", id: value.id, ok: false, code: value.code };
  }
}

export function resultMatchesCommand(command: WorkerCommand, value: WorkerResult): boolean {
  switch (command.operation) {
    case "ping": return "pong" in value;
    case "mail.status": return "state" in value;
    case "credentials.update": return "updated" in value;
    case "mail.sync.start":
    case "mail.sync.stop": return "accepted" in value;
  }
}

export function validWorkerCommand(value: unknown): value is WorkerCommand {
  if (!record(value)) return false;
  if (value.operation === "ping") return exact(value, ["operation"]);
  if (value.operation === "credentials.update") {
    const credentials = value.credentials;
    return exact(value, ["operation", "credentials"]) && record(credentials)
      && Object.keys(credentials).every((key) => ["accountId", "provider", "accessToken", "refreshToken"].includes(key))
      && typeof credentials.accountId === "string" && credentials.accountId.length > 0 && credentials.accountId.length <= 256
      && (credentials.provider === "gmail" || credentials.provider === "graph")
      && (credentials.accessToken === undefined || typeof credentials.accessToken === "string")
      && (credentials.refreshToken === undefined || typeof credentials.refreshToken === "string");
  }
  return typeof value.operation === "string" && ["mail.status", "mail.sync.start", "mail.sync.stop"].includes(value.operation)
    && exact(value, ["operation", "accountId"]) && "accountId" in value
    && typeof value.accountId === "string" && value.accountId.length > 0 && value.accountId.length <= 256;
}

/** Worker-side parser. Apply the same byte cap before buffering/decoding a frame. */
export function parseParentMessage(line: string): ParentMessage | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!record(value)) return;
  if (exact(value, ["kind"]) && value.kind === "shutdown") return { kind: "shutdown" };
  if (exact(value, ["kind", "id", "command"]) && value.kind === "request"
    && typeof value.id === "string" && value.id.length <= 40 && /^[0-9]+:[0-9]+$/.test(value.id)
    && validWorkerCommand(value.command)) return { kind: "request", id: value.id, command: value.command };
  if (!exact(value, ["kind", "protocol", "initialization"]) || value.kind !== "initialize" || value.protocol !== 1
    || !record(value.initialization)) return;
  const input = value.initialization;
  if (!Object.keys(input).every((key) => ["databasePath", "encryptionKey", "credentials"].includes(key))) return;
  const initialization: WorkerInitialization = {};
  if (Object.hasOwn(input, "databasePath")) {
    if (typeof input.databasePath !== "string") return;
    initialization.databasePath = input.databasePath;
  }
  if (Object.hasOwn(input, "encryptionKey")) {
    if (typeof input.encryptionKey !== "string") return;
    initialization.encryptionKey = input.encryptionKey;
  }
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
