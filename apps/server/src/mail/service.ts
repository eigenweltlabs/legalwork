import type {MailUpload} from "./local-view.js";
import type { GraphMailboxInput } from './graph-mailbox-view.js';
import type {SavedSearchInput} from './saved-search-view.js';
import type {ImapConnection} from './providers/imap-config.js';
import type {MailExtractionRequest,MailExtractionRead} from "./extraction-view.js";
import type { MailActionCancel, MailActionPage, MailDraftAttachment, MailDraftAttachmentView, MailDraftDelete, MailDraftPage, MailDraftRead, MailDraftSave, MailDraftSummary, MailDraftView, MailEventPage, MailEventQuery, MailLocalAction, MailLocalPage, MailMutation, MailSubmission } from "./local-view.js";
import type { MailSearchInput, MailSearchRebuildInput } from "./search-view.js";
import { MailWorkerClient, type MailWorkerOptions } from "./runtime/client.js";
import type { WorkerCommand, WorkerResult } from "./runtime/protocol.js";
import { MailServiceError, type MailPageInput, type MailService, type MailServiceStatus } from "./service-interface.js";
import type { MailOAuthSettings } from "./providers/oauth.js";
import type { ProviderMessageLocator } from "./model.js";
import type { MailMessagePageInput, MailPartPageInput, MailContentReadInput } from "./read-view.js";

export type LocalMailServiceOptions = Pick<MailWorkerOptions, "executable" | "entryPoint"> & {
  databasePath: string;
  /** Stable trusted principal for this local store, never a request property. */
  ownerId: string;
  /** Main process OS vault callback. Called only on unlock/restart, never startup. */
  loadKey: () => Promise<Uint8Array>;
  loadStore?: () => Promise<{ databasePath: string; key: Uint8Array }>;
  maintain?: (operation: "rotate" | "backup" | "restore", passphrase: string | undefined, signal: AbortSignal) => Promise<void>;
  /** Trusted main-process configuration; HTTP callers select only a provider. */
  loadProviderSettings?: (provider: "gmail" | "graph", personal?: boolean) => Promise<MailOAuthSettings>;
};
function serviceError(error: unknown): MailServiceError {
  if (error instanceof MailServiceError) return error;
  if (error instanceof Error) {
    if (error.message === "mail_worker_conflict") return new MailServiceError("conflict");
    if (error.message === "mail_worker_invalid_input") return new MailServiceError("invalid_input");
    if (error.message === "mail_worker_not_found") return new MailServiceError("not_found");
    if (error.message === "mail_worker_locked") return new MailServiceError("locked");
    if (error.message === "mail_worker_response_too_large") return new MailServiceError("too_large");
    if (error.message === "mail_worker_unsupported") return new MailServiceError("unsupported");
  }
  return new MailServiceError("unavailable");
}

/** One lazy worker and owner per local store. Lock closes the encrypted connection. */
export class LocalMailService implements MailService {
  private readonly worker: MailWorkerClient;
  private phase: "locked" | "unlocking" | "open" | "locking" = "locked";
  private stopped = false;
  private maintenance?: Promise<void>;
  private maintenanceAbort?: AbortController;
  private readonly maintenanceHandler: LocalMailServiceOptions["maintain"];
  private epoch = 0;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private readonly loadProviderSettings?: LocalMailServiceOptions["loadProviderSettings"];

  constructor(options: LocalMailServiceOptions) {
    this.loadProviderSettings = options.loadProviderSettings;
    this.maintenanceHandler = options.maintain;
    this.worker = new MailWorkerClient({
      executable: options.executable, entryPoint: options.entryPoint,
      initialize: async () => {
        const store = options.loadStore ? await options.loadStore() : { key: await options.loadKey(), databasePath: options.databasePath };
        const key = store.key;
        try {
          if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new MailServiceError("unavailable");
          return { ownerId: options.ownerId, databasePath: store.databasePath, encryptionKey: Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString("base64") };
        } finally { if (key instanceof Uint8Array) key.fill(0); }
      },
    });
  }
  async configureGraphMailbox(input:GraphMailboxInput) {
    const result=await this.request({operation:'mail.graph.mailbox.configure',input});
    if(!('graphMailbox' in result))throw new MailServiceError('unavailable');
    await this.startSync(result.graphMailbox.accountId);
    return result.graphMailbox;
  }
  async unreadInboxCount(): Promise<number> {
    const result = await this.request({ operation: "mail.badge.count" });
    if (!("unreadInboxCount" in result)) throw new MailServiceError("unavailable");
    return result.unreadInboxCount;
  }
  status(): MailServiceStatus {
    let state: MailServiceStatus["state"];
    if (this.stopped) state = "stopped";
    else if (this.phase === "open") state = this.worker.status().state === "ready" ? "ready" : "unavailable";
    else state = this.phase;
    return { protocolVersion: 1, state, syncSupported: true };
  }
  unlock(): Promise<void> {
    if (this.stopped) return Promise.reject(new MailServiceError("unavailable"));
    if (this.maintenance) return Promise.reject(new MailServiceError("locked"));
    if (this.closing) return Promise.reject(new MailServiceError("locked"));
    if (this.opening) return this.opening;
    if (this.status().state === "ready") return Promise.resolve();
    // An explicit retry from unavailable first tears down any failed generation.
    this.epoch++;
    this.phase = "unlocking";
    const attempt = (async () => {
      try {
        if (this.worker.status().state !== "stopped") await this.worker.stop();
        if (this.phase !== "unlocking" || this.stopped) throw new MailServiceError("locked");
        await this.worker.start();
        if (this.phase !== "unlocking" || this.stopped) throw new MailServiceError("locked");
        this.phase = "open";
        let cursor: string | undefined;
        do {
          const page = await this.listAccounts({ limit: 100, ...(cursor ? {after: cursor} : {}) });
          await Promise.all(page.items.map(account => this.startSync(account.id, true).catch(() => {})));
          cursor = page.nextCursor ?? undefined;
        } while (cursor && this.phase === "open");
      } catch (error) {
        // This opening also owns the open phase while enumerating accounts. A
        // concurrent lock owns its own teardown; never overwrite its state.
        if (this.phase === "unlocking" || this.phase === "open") {
          const cleanupEpoch = this.epoch;
          this.phase = "locking";
          await this.worker.stop();
          if (this.epoch === cleanupEpoch && this.phase === "locking") this.phase = "locked";
        }
        throw serviceError(error);
      }
    })();
    this.opening = attempt;
    void attempt.finally(() => { if (this.opening === attempt) this.opening = undefined; }).catch(() => {});
    return attempt;
  }
  lock(): Promise<void> {
    this.maintenanceAbort?.abort();
    if (this.closing) return this.closing;
    this.epoch++;
    this.phase = "locking"; // Reject new operations before awaiting child cleanup.
    const opening = this.opening;
    const closing = (async () => {
      await this.worker.stop();
      await opening?.catch(() => {});
      this.phase = "locked";
    })();
    this.closing = closing;
    void closing.finally(() => { if (this.closing === closing) this.closing = undefined; }).catch(() => {});
    return closing;
  }
  private async request(command: WorkerCommand): Promise<WorkerResult> {
    if (this.stopped) throw new MailServiceError("unavailable");
    if (this.phase !== "open") throw new MailServiceError("locked");
    const epoch = this.epoch;
    try {
      const result = await this.worker.request(command);
      if (epoch !== this.epoch || this.phase !== "open" || this.stopped) throw new MailServiceError("locked");
      return result;
    }
    catch (error) { throw serviceError(error); }
  }
  async savedSearch(input:SavedSearchInput){const result=await this.request({operation:'mail.search.saved',input});if(!('savedSearch' in result))throw new MailServiceError('unavailable');return result.savedSearch;}
  async extractionStatus(accountId:string,input:MailExtractionRequest){const result=await this.request({operation:'mail.extraction.status',accountId,input});if(!('extraction' in result))throw new MailServiceError('unavailable');return result.extraction;}
  async extractionRead(accountId:string,input:MailExtractionRead){const result=await this.request({operation:'mail.extraction.read',accountId,input});if(!('extractionText' in result))throw new MailServiceError('unavailable');return result.extractionText;}
  async extractionReset(accountId:string,input:MailExtractionRequest){const result=await this.request({operation:'mail.extraction.reset',accountId,input});if(!('extraction' in result))throw new MailServiceError('unavailable');return result.extraction;}
  async uploadDraft(accountId:string,input:MailUpload){const result=await this.request({operation:"mail.local.draft.upload",accountId,input});if(!("local" in result)||result.local.operation!=="mail.local.draft.upload")throw new MailServiceError("unavailable");return result.local.value;}
  async saveDraft(accountId:string,input:MailDraftSave){
    const result=await this.request({operation:"mail.local.draft.save",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.draft.save")throw new MailServiceError("unavailable");return result.local.value;
  }
  async readDraft(accountId:string,input:MailDraftRead){
    const result=await this.request({operation:"mail.local.draft.read",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.draft.read")throw new MailServiceError("unavailable");return result.local.value;
  }
  async deleteDraft(accountId:string,input:MailDraftDelete){
    const result=await this.request({operation:"mail.local.draft.delete",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.draft.delete")throw new MailServiceError("unavailable");return result.local.value;
  }
  async readDraftAttachment(accountId:string,input:MailDraftAttachment){
    const result=await this.request({operation:"mail.local.draft.attachment",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.draft.attachment")throw new MailServiceError("unavailable");return result.local.value;
  }
  async listDrafts(accountId:string,input:MailLocalPage){
    const result=await this.request({operation:"mail.local.draft.list",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.draft.list")throw new MailServiceError("unavailable");return result.local.value;
  }
  async enqueueSubmission(accountId:string,input:MailSubmission){
    const result=await this.request({operation:"mail.local.action.submission",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.action.submission")throw new MailServiceError("unavailable");return result.local.value;
  }
  async enqueueMutation(accountId:string,input:MailMutation){
    const result=await this.request({operation:"mail.local.action.mutation",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.action.mutation")throw new MailServiceError("unavailable");return result.local.value;
  }
  async readAction(accountId:string,actionId:string){
    const result=await this.request({operation:"mail.local.action.read",accountId,input:{actionId}});
    if(!("local" in result)||result.local.operation!=="mail.local.action.read")throw new MailServiceError("unavailable");return result.local.value;
  }
  async listActions(accountId:string,input:MailLocalPage){
    const result=await this.request({operation:"mail.local.action.list",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.action.list")throw new MailServiceError("unavailable");return result.local.value;
  }
  async cancelAction(accountId:string,input:MailActionCancel){
    const result=await this.request({operation:"mail.local.action.cancel",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.action.cancel")throw new MailServiceError("unavailable");return result.local.value;
  }
  async listEvents(accountId:string,input:MailEventQuery){
    const result=await this.request({operation:"mail.local.events",accountId,input:input});
    if(!("local" in result)||result.local.operation!=="mail.local.events")throw new MailServiceError("unavailable");return result.local.value;
  }
  async search(input: MailSearchInput) {
    const result = await this.request({operation:"mail.search",input});
    if (!("search" in result)) throw new MailServiceError("unavailable");
    return result.search;
  }
  async rebuildSearch(input: MailSearchRebuildInput) {
    const result = await this.request({operation:"mail.search.rebuild",input});
    if (!("rebuilt" in result)) throw new MailServiceError("unavailable");
    return result.rebuilt;
  }
  async listAccounts(page: MailPageInput) {
    const result = await this.request({ operation: "mail.accounts.list", ...page });
    if (!("accounts" in result)) throw new MailServiceError("unavailable");
    return { items: result.accounts, nextCursor: result.nextCursor };
  }
  async listFolders(accountId: string, page: MailPageInput) {
    const result = await this.request({ operation: "mail.folders.list", accountId, ...page });
    if (!("folders" in result)) throw new MailServiceError("unavailable");
    return { items: result.folders, nextCursor: result.nextCursor };
  }
  async beginConnection(provider: "gmail" | "graph", reconnectAccountId?: string, personal = false) {
    if (this.stopped || !this.loadProviderSettings) throw new MailServiceError("unavailable");
    if (this.phase !== "open") throw new MailServiceError("locked");
    const epoch = this.epoch;
    let settings: MailOAuthSettings;
    try {
      if (reconnectAccountId !== undefined) {
        const stored = await this.request({operation:"mail.sync.provider",accountId:reconnectAccountId});
        if (!("syncProvider" in stored) || stored.syncProvider !== provider) throw new MailServiceError("unavailable");
        personal = stored.personal === true;
      }
      settings = await this.loadProviderSettings(provider, personal);
    }
    catch { throw new MailServiceError("unavailable"); }
    if (epoch !== this.epoch) throw new MailServiceError("locked");
    if (settings.provider !== provider) throw new MailServiceError("unavailable");
    const result = await this.request({ operation: "mail.connection.begin", settings,
      ...(reconnectAccountId === undefined ? {} : { reconnectAccountId }) });
    if (!("connectionStarted" in result)) throw new MailServiceError("unavailable");
    return result.connectionStarted;
  }
  async listMessages(accountId: string, page: MailMessagePageInput) {
    const result = await this.request({ operation: "mail.messages.list", accountId, page });
    if (!("messages" in result)) throw new MailServiceError("unavailable");
    return { items: result.messages.items, nextCursor: result.messages.nextCursor };
  }
  async readMessage(accountId: string, locator: ProviderMessageLocator) {
    const result = await this.request({ operation: "mail.messages.read", accountId, locator });
    if (!("message" in result)) throw new MailServiceError("unavailable");
    return result.message;
  }
  async listParts(accountId: string, locator: ProviderMessageLocator, page: MailPartPageInput) {
    const result = await this.request({ operation: "mail.parts.list", accountId, locator, page });
    if (!("parts" in result)) throw new MailServiceError("unavailable");
    return { items: result.parts.items, nextCursor: result.parts.nextCursor };
  }
  async readContent(accountId: string, locator: ProviderMessageLocator, request: MailContentReadInput) {
    const result = await this.request({ operation: "mail.content.read", accountId, locator, request });
    if (!("content" in result)) throw new MailServiceError("unavailable");
    return result.content;
  }
  async connectionStatus(connectionId: string) {
    const result = await this.request({ operation: "mail.connection.poll", connectionId });
    if (!("connection" in result)) throw new MailServiceError("unavailable");
    return result.connection;
  }
  async cancelConnection(connectionId: string) {
    const result = await this.request({ operation: "mail.connection.cancel", connectionId });
    if (!("cancelled" in result)) throw new MailServiceError("unavailable");
  }
  async disconnectAccount(accountId: string) {
    // Invalidate pending configuration loads before the worker advances its credential fence.
    this.epoch++;
    const result = await this.request({ operation: "mail.account.disconnect", accountId });
    if (!("disconnected" in result)) throw new MailServiceError("unavailable");
  }
  async imapDiscovery(accountId:string,after?:string){const result=await this.request({operation:"mail.imap.discovery",accountId,...(after===undefined?{}:{after})});if(!("imapDiscovery" in result))throw new MailServiceError("unavailable");return result.imapDiscovery;}
  async cancelImapConnection(requestId:string){await this.request({operation:"mail.imap.cancel",requestId});}
  async connectImap(input:ImapConnection,requestId?:string){const result=await this.request({operation:"mail.imap.connect",input,...(requestId?{requestId}:{})});if(!("imapConnection" in result))throw new MailServiceError("unavailable");return result.imapConnection;}
  async startSync(accountId: string, automatic = false) {
    const operation = automatic ? "mail.sync.resume" : "mail.sync.start";
    if (this.stopped) throw new MailServiceError("unavailable");
    if (this.phase !== "open") throw new MailServiceError("locked");
    const epoch = this.epoch;
    let settings: MailOAuthSettings;
    try {
      const provider = await this.request({ operation: "mail.sync.provider", accountId });
      if (!("syncProvider" in provider)) throw new MailServiceError("unavailable");
      if (automatic && provider.connected === false) return this.syncStatus(accountId);
      if(provider.syncProvider==='imap'){if(epoch!==this.epoch)throw new MailServiceError('locked');const result=await this.request({operation,accountId});if(!('sync' in result))throw new MailServiceError('unavailable');return result.sync;}
      if(!this.loadProviderSettings)throw new MailServiceError('unavailable');
      settings = await this.loadProviderSettings(provider.syncProvider, provider.personal);
      if (settings.provider !== provider.syncProvider) throw new MailServiceError("unavailable");
    }
    catch { throw new MailServiceError("unavailable"); }
    if (epoch !== this.epoch) throw new MailServiceError("locked");
    const result = await this.request({ operation, accountId, settings });
    if (!("sync" in result)) throw new MailServiceError("unavailable");
    return result.sync;
  }
  async pauseSync(accountId: string) {
    this.epoch++; // A pause also cancels a start still awaiting trusted configuration.
    const result = await this.request({ operation: "mail.sync.stop", accountId });
    if (!("sync" in result)) throw new MailServiceError("unavailable");
    return result.sync;
  }
  async syncStatus(accountId: string) {
    const result = await this.request({ operation: "mail.status", accountId });
    if (!("sync" in result)) throw new MailServiceError("unavailable");
    return result.sync;
  }
  maintain(operation: "rotate" | "backup" | "restore", passphrase?: string): Promise<void> {
    if (this.stopped || !this.maintenanceHandler) return Promise.reject(new MailServiceError("unavailable"));
    if (this.maintenance) return Promise.reject(new MailServiceError("locked"));
    const signal = new AbortController();
    const closing = this.lock();
    this.maintenanceAbort = signal;
    const operationTask = (async () => {
      try {
        await closing;
        if (signal.signal.aborted || this.stopped) throw new MailServiceError("locked");
        await this.maintenanceHandler?.(operation, passphrase, signal.signal);
      } catch { throw new MailServiceError("unavailable"); }
    })();
    this.maintenance = operationTask;
    void operationTask.finally(() => { if (this.maintenance === operationTask) { this.maintenance = undefined; this.maintenanceAbort = undefined; } }).catch(() => {});
    return operationTask;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.lock();
    await this.maintenance?.catch(() => {});
  }
}
