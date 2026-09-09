/** Production Node/Electron entrypoint. stdout is exclusively the private worker protocol. */
import { MailConnectionController, MailConnectionError } from "../providers/connection-controller.js";
import { MailCredentialRepository, MailCredentialError } from "../storage/credentials.js";
import { isAbsolute } from "node:path";
import { openEncryptedMailDatabase } from "../storage/database.js";
import type { MailDatabase } from "../storage/database-interface.js";
import { MailRepository } from "../storage/repository.js";
import { MAIL_SCHEMA_VERSION, migrateMailSchema } from "../storage/schema.js";
import { assertMailSchema } from "../storage/consistency.js";
import { MAX_WORKER_MESSAGE_BYTES, parseParentMessage, parseWorkerMessage,
  type ParentMessage, type WorkerInitialization, type WorkerMessage, type WorkerResult, type WorkerAccount, type WorkerFolder } from "./protocol.js";

let database: MailDatabase | undefined;
let repository: MailRepository | undefined;
let controller: MailConnectionController | undefined;
let closingController: Promise<void> | undefined;
let credentials: MailCredentialRepository | undefined;
const requests = new Set<Promise<void>>();
const locked = new Error("mail_archive_locked");
let phase: "waiting" | "opening" | "ready" | "closing" = "waiting";
let input = Buffer.alloc(0);
let opening: Promise<void> | undefined;
let exitCode = 0;
function isClosing(): boolean { return phase === "closing"; }
// Shutdown cannot wait indefinitely for a misbehaving native opener or a blocked parent pipe.
let exitTimer: ReturnType<typeof setTimeout> | undefined;

function write(message: WorkerMessage): boolean {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) > MAX_WORKER_MESSAGE_BYTES || !parseWorkerMessage(encoded)) return false;
  if (process.stdout.writableLength > 4 * MAX_WORKER_MESSAGE_BYTES) { shutdown(1); return false; }
  process.stdout.write(`${encoded}\n`);
  return true;
}
async function finish(): Promise<void> {
  try { await (closingController ?? controller?.close()); } catch { exitCode = 1; }
  await Promise.allSettled(requests);
  controller = undefined;
  credentials = undefined;
  try { database?.close(); } catch { exitCode = 1; }
  database = undefined;
  repository = undefined;
  process.stdout.end(() => { clearTimeout(exitTimer); process.exit(exitCode); });
}
function shutdown(code = 0): void {
  exitCode = Math.max(exitCode, code);
  if (phase === "closing") return;
  phase = "closing";
  // close() marks the controller closed synchronously, before any queued continuation.
  closingController = controller?.close();
  input = Buffer.alloc(0);
  process.stdin.pause();
  exitTimer = setTimeout(() => process.exit(1), 2000);
  if (opening) void opening.finally(finish);
  else void finish();
}
function fatal(code: "initialization_failed" | "protocol_error"): void {
  write({ kind: "fatal", code });
  shutdown(1);
}

async function initialize(value: WorkerInitialization): Promise<void> {
  let key: Buffer | undefined;
  try {
    if (!value.ownerId || value.ownerId.length > 4096 || !value.databasePath || !isAbsolute(value.databasePath)
      || value.databasePath.includes("\0") || typeof value.encryptionKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.encryptionKey)
      || (value.credentials?.length ?? 0) > 0) throw new Error("invalid_initialization");
    key = Buffer.from(value.encryptionKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== value.encryptionKey) throw new Error("invalid_key");
    database = await openEncryptedMailDatabase({ path: value.databasePath, key });
    if (phase === "closing") return;
    migrateMailSchema(database);
    assertMailSchema(database);
    repository = new MailRepository(database, value.ownerId);
    credentials = new MailCredentialRepository(database, value.ownerId);
    controller = new MailConnectionController({ database, ownerId: value.ownerId });
    phase = "ready";
    write({ kind: "ready", protocol: 1, runtime: "node", nodeVersion: process.versions.node });
  } catch {
    if (phase !== "closing") fatal("initialization_failed");
  } finally { key?.fill(0); }
}

/** Cap encoded results as well as SQL row count; never advance beyond the last returned row. */
function pageResult(id: string, items: WorkerAccount[], hasMore: boolean): WorkerResult | undefined;
function pageResult(id: string, items: WorkerFolder[], hasMore: boolean, folders: true): WorkerResult | undefined;
function pageResult(id: string, items: WorkerAccount[] | WorkerFolder[], hasMore: boolean, folders?: true): WorkerResult | undefined {
  const selectedAccounts: WorkerAccount[] = [];
  const selectedFolders: WorkerFolder[] = [];
  let accepted: WorkerResult = folders ? { folders: [], nextCursor: null } : { accounts: [], nextCursor: null };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if ("provider" in item) selectedAccounts.push(item); else selectedFolders.push(item);
    const nextCursor = hasMore || index < items.length - 1 ? item.id : null;
    const candidate: WorkerResult = folders ? { folders: [...selectedFolders], nextCursor } : { accounts: [...selectedAccounts], nextCursor };
    if (Buffer.byteLength(JSON.stringify({ kind: "response", id, ok: true, result: candidate })) > MAX_WORKER_MESSAGE_BYTES) return index === 0 ? undefined : accepted;
    accepted = candidate;
  }
  return accepted;
}
async function request(message: Extract<ParentMessage, { kind: "request" }>): Promise<void> {
  if (phase !== "ready" || !repository || !controller || !credentials) {
    write({ kind: "response", id: message.id, ok: false, code: "not_ready" }); return;
  }
  const command = message.command;
  try {
    let result: WorkerResult | undefined;
    switch (command.operation) {
      case "ping": result = { pong: true }; break;
      case "mail.storage.status": result = { encrypted: true, schemaVersion: MAIL_SCHEMA_VERSION, syncSupported: false }; break;
      case "mail.connection.begin":
        result = { connectionStarted: await controller.begin(command.settings, { reconnectAccountId: command.reconnectAccountId }) }; break;
      case "mail.connection.poll": result = { connection: controller.poll(command.connectionId) }; break;
      case "mail.connection.cancel": await controller.cancel(command.connectionId); result = { cancelled: true }; break;
      case "mail.account.disconnect": await controller.disconnect(command.accountId); result = { disconnected: true }; break;
      case "mail.accounts.list": {
        const page = repository.listAccountsPage({ limit: command.limit, after: command.after });
        result = pageResult(message.id, page.items.map((account) => ({ id: account.id, provider: account.provider, displayName: account.display_name })), page.hasMore);
        break;
      }
      case "mail.folders.list": {
        if (credentials.status(command.accountId).state === "disconnected") throw locked;
        const page = repository.listFoldersPage(command.accountId, { limit: command.limit, after: command.after });
        result = pageResult(message.id, page.items.map((folder) => ({ id: folder.id, name: folder.name, kind: folder.kind, parentId: folder.parent_id })), page.hasMore, true);
        break;
      }
      case "mail.status":
        if (credentials.status(command.accountId).state === "disconnected") throw locked;
        // An owner-bound lookup verifies the account without fetching its folders.
        repository.listFoldersPage(command.accountId, { limit: 1 });
        result = { state: "idle", syncSupported: false }; break;
      case "mail.sync.start":
      case "mail.sync.stop":
      case "credentials.update":
        write({ kind: "response", id: message.id, ok: false, code: "unsupported" }); return;
    }
    if (isClosing()) return;
    if (!result) { write({ kind: "response", id: message.id, ok: false, code: "response_too_large" }); return; }
    if (!write({ kind: "response", id: message.id, ok: true, result })) write({ kind: "response", id: message.id, ok: false, code: "operation_failed" });
  } catch (error) {
    // Do not echo SQLite/provider errors, row contents, supplied IDs, paths or key material.
    if (isClosing()) return;
    const code = error === locked ? "locked" :
      (error instanceof MailConnectionError && (error.code === "not_found" || error.code === "account_not_found"))
      || (error instanceof MailCredentialError && error.code === "account_not_found")
      || (error instanceof Error && error.message === "Mail account not found") ? "not_found" : "operation_failed";
    write({ kind: "response", id: message.id, ok: false, code });
  }
}
function receive(message: ParentMessage): void {
  if (phase === "closing") return;
  if (message.kind === "shutdown") { shutdown(); return; }
  if (message.kind === "initialize") {
    if (phase !== "waiting") { fatal("protocol_error"); return; }
    phase = "opening";
    opening = initialize(message.initialization);
    return;
  }
  if (requests.size >= 64) { write({ kind: "response", id: message.id, ok: false, code: "operation_failed" }); return; }
  const pending = request(message);
  requests.add(pending);
  void pending.finally(() => requests.delete(pending));
}
process.stdin.on("data", (chunk: Buffer) => {
  if (phase === "closing") return;
  input = Buffer.concat([input, chunk]);
  let newline = input.indexOf(10);
  while (newline !== -1) {
    if (newline > MAX_WORKER_MESSAGE_BYTES) { fatal("protocol_error"); return; }
    const message = parseParentMessage(input.subarray(0, newline).toString("utf8"));
    input = input.subarray(newline + 1);
    if (!message) { fatal("protocol_error"); return; }
    receive(message);
    if (isClosing()) return;
    newline = input.indexOf(10);
  }
  if (input.length > MAX_WORKER_MESSAGE_BYTES) fatal("protocol_error");
});
process.stdin.on("end", () => shutdown(input.length > 0 ? 1 : 0));
process.stdin.on("error", () => shutdown(1));
process.stdout.on("error", () => shutdown(1));
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
process.on("uncaughtException", () => shutdown(1));
process.on("unhandledRejection", () => shutdown(1));
