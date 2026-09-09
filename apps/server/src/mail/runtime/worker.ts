import {MailLocalApiStore,MailLocalError} from "../storage/local-api.js";
import { MailSearchIndexer } from "./search-indexer.js";
import { MailSearchStore, MailSearchError } from "../storage/search.js";
/** Production Node/Electron entrypoint. stdout is exclusively the private worker protocol. */
import { MailConnectionController, MailConnectionError } from "../providers/connection-controller.js";
import { MailCredentialRepository, MailCredentialError } from "../storage/credentials.js";
import { MailAccessCoordinator } from "../providers/access-coordinator.js";
import { GraphBackfill, GraphBackfillError } from "../providers/graph-backfill.js";
import { GmailBackfill, GmailBackfillError } from "../providers/gmail-backfill.js";
import { createStoredMimeProjector } from "../storage/mime-projection.js";
import type { MailOAuthSettings } from "../providers/oauth.js";
import { isAbsolute } from "node:path";
import { openEncryptedMailDatabase } from "../storage/database.js";
import type { MailDatabase } from "../storage/database-interface.js";
import { MailRepository } from "../storage/repository.js";
import { MailReadStore } from "../storage/read-store.js";
import { MAIL_SCHEMA_VERSION, migrateMailSchema } from "../storage/schema.js";
import { assertMailSchema } from "../storage/consistency.js";
import { MAX_WORKER_MESSAGE_BYTES, parseParentMessage, parseWorkerMessage,
  type ParentMessage, type WorkerInitialization, type WorkerMessage, type WorkerResult, type WorkerAccount, type WorkerFolder } from "./protocol.js";

let database: MailDatabase | undefined;
let repository: MailRepository | undefined;
let local:MailLocalApiStore|undefined;
let reads: MailReadStore | undefined;
let search: MailSearchStore | undefined;
let searchIndexer: MailSearchIndexer | undefined;
let controller: MailConnectionController | undefined;
let closingController: Promise<void> | undefined;
let credentials: MailCredentialRepository | undefined;
let backfill: GmailBackfill | undefined;
let graph: GraphBackfill | undefined;
let closingGraph: Promise<void> | undefined;
let access: MailAccessCoordinator | undefined;
let closingBackfill: Promise<void> | undefined;
const providerSettings = new Map<string, MailOAuthSettings>();
const requests = new Set<Promise<void>>();
const locked = new Error("mail_archive_locked");
const unsupported = new Error("mail_provider_unsupported");
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
  try { await (closingBackfill ?? backfill?.close()); } catch { exitCode = 1; }
  try { await (closingGraph ?? graph?.close()); } catch { exitCode = 1; }
  await Promise.allSettled(requests);
  controller = undefined;
  credentials = undefined;
  backfill = undefined;
  graph = undefined;
  access = undefined;
  providerSettings.clear();
  try { database?.close(); } catch { exitCode = 1; }
  database = undefined;
  repository = undefined;
  reads = undefined;
  process.stdout.end(() => { clearTimeout(exitTimer); process.exit(exitCode); });
}
function shutdown(code = 0): void {
  searchIndexer?.close();
  exitCode = Math.max(exitCode, code);
  if (phase === "closing") return;
  phase = "closing";
  // close() marks the controller closed synchronously, before any queued continuation.
  closingController = controller?.close();
  closingBackfill = backfill?.close();
  closingGraph = graph?.close();
  access?.close();
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
    local=new MailLocalApiStore(database,value.ownerId);
    reads = new MailReadStore(database, value.ownerId);
    search = new MailSearchStore(database, value.ownerId);
    searchIndexer = new MailSearchIndexer(database,value.ownerId);
    credentials = new MailCredentialRepository(database, value.ownerId);
    controller = new MailConnectionController({ database, ownerId: value.ownerId });
    access = new MailAccessCoordinator({ database, ownerId: value.ownerId, loadProviderSettings: async binding => {
      const selected = providerSettings.get(`${binding.provider}:${binding.clientId}`);
      if (!selected) throw new Error("mail_configuration_unavailable");
      return selected;
    } });
    backfill = new GmailBackfill({ database, ownerId: value.ownerId, access,
      projectRaw: createStoredMimeProjector({ database, ownerId: value.ownerId }) });
    graph = new GraphBackfill({ database, ownerId: value.ownerId, access });
    phase = "ready";
    searchIndexer?.start();
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
  if (phase !== "ready" || !repository || !reads || !controller || !credentials || !backfill || !graph || !database) {
    write({ kind: "response", id: message.id, ok: false, code: "not_ready" }); return;
  }
  const command = message.command;
  try {
    let result: WorkerResult | undefined;
    switch (command.operation) {
      case "mail.search": if (!search) throw locked; result = {search:search.search(command.input)}; break;
      case "mail.search.rebuild": if (!search) throw locked; result = {rebuilt:search.rebuild(command.input)}; break;
      case "mail.local.draft.save": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.saveDraft(command.accountId,command.input)}};break;
      case "mail.local.draft.read": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.readDraft(command.accountId,command.input)}};break;
      case "mail.local.draft.delete": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.deleteDraft(command.accountId,command.input)}};break;
      case "mail.local.draft.attachment": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.readDraftAttachment(command.accountId,command.input)}};break;
      case "mail.local.draft.list": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.listDrafts(command.accountId,command.input)}};break;
      case "mail.local.action.submission": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.enqueueSubmission(command.accountId,command.input)}};break;
      case "mail.local.action.mutation": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.enqueueMutation(command.accountId,command.input)}};break;
      case "mail.local.action.read": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.readAction(command.accountId,command.input.actionId)}};break;
      case "mail.local.action.list": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.listActions(command.accountId,command.input)}};break;
      case "mail.local.action.cancel": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.cancelAction(command.accountId,command.input)}};break;
      case "mail.local.events": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.events(command.accountId,command.input)}};break;
      case "ping": result = { pong: true }; break;
      case "mail.storage.status": result = { encrypted: true, schemaVersion: MAIL_SCHEMA_VERSION, syncSupported: true }; break;
      case "mail.connection.begin":
        result = { connectionStarted: await controller.begin(command.settings, { reconnectAccountId: command.reconnectAccountId }) }; break;
      case "mail.connection.poll": result = { connection: controller.poll(command.connectionId) }; break;
      case "mail.connection.cancel": await controller.cancel(command.connectionId); result = { cancelled: true }; break;
      case "mail.account.disconnect": {
        const current = credentials.status(command.accountId); // Owner gate before provider lookup or cancellation.
        if (current.state !== "disconnected" && database.get("SELECT provider FROM mail_accounts WHERE id=?", [command.accountId])?.provider === "gmail") {
          // Abort publication before rotating the durable credential generation.
          // A journal failure must not prevent the credential revocation attempt.
          try { backfill.pause(command.accountId); } catch { /* The credential generation also fences every late publication. */ }
        }
        try { if (database.get("SELECT provider FROM mail_accounts WHERE id=?", [command.accountId])?.provider === "graph") graph.pause(command.accountId); } catch { /* Durable credential rotation still fences publication. */ }
        await controller.disconnect(command.accountId); result = { disconnected: true }; break;
      }
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
      case "mail.sync.provider":
      case "mail.status":
      case "mail.sync.start":
      case "mail.sync.stop": {
        if (credentials.status(command.accountId).state === "disconnected") throw locked;
        const provider = database.get("SELECT provider FROM mail_accounts WHERE id=?", [command.accountId])?.provider;
        if (provider !== "gmail" && provider !== "graph") throw unsupported;
        if (command.operation === "mail.sync.provider") { result = { syncProvider: provider }; break; }
        const engine = provider === "gmail" ? backfill : graph;
        if (command.operation === "mail.sync.start") {
          const binding = credentials.getBinding(command.accountId);
          if (command.settings.provider !== provider || binding.clientId !== command.settings.clientId
            || binding.authority !== (command.settings.provider === "gmail" ? "https://accounts.google.com" : `https://login.microsoftonline.com/${command.settings.tenantId}/v2.0`)) throw new Error("mail_configuration_mismatch");
          providerSettings.set(`${provider}:${binding.clientId}`, command.settings);
          result = { sync: engine.start(command.accountId) };
        } else result = { sync: command.operation === "mail.sync.stop" ? engine.pause(command.accountId) : engine.status(command.accountId) };
        break;
      }
      case "mail.messages.list":
      case "mail.messages.read":
      case "mail.parts.list":
      case "mail.content.read": {
        if (credentials.status(command.accountId).state === "disconnected") throw locked;
        if (command.operation === "mail.messages.read") result = { message: reads.read(command.accountId, command.locator) };
        else if (command.operation === "mail.content.read") result = { content: reads.chunk(command.accountId, command.locator, command.request) };
        else {
          const page: { messages: ReturnType<MailReadStore["list"]> } | { parts: ReturnType<MailReadStore["parts"]> } = command.operation === "mail.messages.list" ? { messages: reads.list(command.accountId, command.page) } : { parts: reads.parts(command.accountId, command.locator, command.page) };
          // Bound the encoded response while preserving the last returned key as continuation.
          const collection = "messages" in page ? page.messages : page.parts;
          const hadItems = collection.items.length > 0;
          while (collection.items.length && Buffer.byteLength(JSON.stringify({ kind: "response", id: message.id, ok: true, result: page })) > MAX_WORKER_MESSAGE_BYTES) {
            collection.items.pop(); collection.nextCursor = collection.items.at(-1)?.key ?? null;
          }
          result = hadItems && collection.items.length === 0 ? undefined : page;
        }
        break;
      }
      case "credentials.update":
        write({ kind: "response", id: message.id, ok: false, code: "unsupported" }); return;
    }
    if(result&&'local' in result){
      const localResult=result.local;
      if(localResult.operation==='mail.local.events'){
        const page=localResult.value;
        while(page.items.length&&Buffer.byteLength(JSON.stringify({kind:'response',id:message.id,ok:true,result}))>MAX_WORKER_MESSAGE_BYTES){
          page.items.pop();page.hasMore=true;
          if(page.items.length)page.nextCursor=page.items.at(-1)!.sequence;else{result=undefined;break;}
        }
      }else if(localResult.operation==='mail.local.draft.list'||localResult.operation==='mail.local.action.list'){
        const page=localResult.value;
        while(page.items.length&&Buffer.byteLength(JSON.stringify({kind:'response',id:message.id,ok:true,result}))>MAX_WORKER_MESSAGE_BYTES){
          page.items.pop();page.nextCursor=page.items.at(-1)?.id??null;
          if(!page.items.length){result=undefined;break;}
        }
      }
    }
    if (isClosing()) return;
    if (!result || Buffer.byteLength(JSON.stringify({ kind: "response", id: message.id, ok: true, result })) > MAX_WORKER_MESSAGE_BYTES) {
      write({ kind: "response", id: message.id, ok: false, code: "response_too_large" }); return;
    }
    if (!write({ kind: "response", id: message.id, ok: true, result })) write({ kind: "response", id: message.id, ok: false, code: "operation_failed" });
  } catch (error) {
    // Do not echo SQLite/provider errors, row contents, supplied IDs, paths or key material.
    if (isClosing()) return;
    const code = error instanceof MailLocalError&&error.code==="conflict"?"conflict":error instanceof MailLocalError&&error.code==="invalid_input"?"invalid_input":error instanceof MailLocalError&&error.code==="locked"?"locked":error instanceof MailLocalError&&error.code==="not_found"?"not_found":error === unsupported || (error instanceof MailSearchError && error.code === "unsupported") ? "unsupported" : error === locked || (error instanceof MailSearchError && error.code === "locked") || ((error instanceof GmailBackfillError || error instanceof GraphBackfillError) && error.code === "locked")
      || (error instanceof MailCredentialError && error.code === "disconnected") ? "locked" :
      (error instanceof MailConnectionError && (error.code === "not_found" || error.code === "account_not_found"))
      || (error instanceof MailCredentialError && error.code === "account_not_found")
      || ((error instanceof GmailBackfillError || error instanceof GraphBackfillError) && error.code === "not_found")
      || (error instanceof MailSearchError && error.code === "not_found")
      || (error instanceof Error && ["Mail account not found", "Mail message not found", "Mail content not found"].includes(error.message)) ? "not_found" : "operation_failed";
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
