import type {MailMaintenanceReport} from './maintenance-view.js';
import type {RetentionCommand,RetentionPreview} from './retention-view.js';
import type {MailNotificationPoll,MailNotificationBatch} from './notification-view.js';
import type {OutboxItem,SmtpStatus,SmtpConfigure} from './outbox-view.js';
import type {SenderIdentity,SenderSettings,SenderConfigure} from './sender-view.js';
import type {DraftSyncRequest,DraftSyncStatus} from "./draft-sync-view.js";
import type {MailUpload,MailUploadView} from "./local-view.js";
import type { GraphMailboxInput, GraphMailboxIdentity } from './graph-mailbox-view.js';
import type {SavedSearchInput,SavedSearchResult} from './saved-search-view.js';
import type {ImapDiscovery,ImapConnection,ImapConnectionResult} from './providers/imap-config.js';
import type {MailExtractionRequest,MailExtractionRead,MailExtractionStatus,MailExtractionText} from "./extraction-view.js";
import type { MailActionCancel, MailActionPage, MailDraftAttachment, MailDraftAttachmentView, MailDraftDelete, MailDraftPage, MailDraftRead, MailDraftSave, MailDraftSummary, MailDraftView, MailEventPage, MailEventQuery, MailLocalAction, MailLocalPage, MailActionPageInput, MailMutation, MailSubmission } from "./local-view.js";
import type { MailSearchInput, MailSearchResult, MailSearchRebuildInput, MailSearchRebuildResult } from "./search-view.js";
export type MailPageInput = { limit?: number; after?: string };
export type MailAccountView = { id: string; provider: "gmail" | "graph" | "imap" | "archive"; displayName: string; personal?: boolean; identity?: GraphMailboxIdentity };
export type MailFolderView = { id: string; name: string; kind: "folder" | "label"; parentId: string | null; mutationPrecondition?: string | null; role?: "inbox" };
export type MailPage<T> = { items: T[]; nextCursor: string | null };
export type MailServiceStatus = {
  protocolVersion: 1;
  state: "locked" | "unlocking" | "ready" | "unavailable" | "locking" | "stopped";
  syncSupported: boolean;
};
export class MailServiceError extends Error {
  constructor(readonly code: "not_found" | "locked" | "unavailable" | "too_large" | "unsupported" | "conflict" | "invalid_input") { super(`mail_${code}`); }
}

/** Bound to one trusted owner at construction; no request supplies an owner ID. */
export interface MailService {
  pollNotifications(input:MailNotificationPoll):Promise<MailNotificationBatch>;
  setLifecycleSuspended(suspended:boolean):Promise<{state:'running'|'suspended'}>;
  lifecycleStatus():Promise<{state:'running'|'suspended'}>;
  retention?(command:RetentionCommand):Promise<RetentionPreview|{removedDays:number|null}|{accountId:string;removedAccount:boolean;messages:number;references:number;bytes:number;protectedReferences:number}>;
  outbox(accountId:string):Promise<OutboxItem[]>;
  queueOutbox(accountId:string,input:MailSubmission):Promise<OutboxItem>;
  outboxAction(accountId:string,input:{actionId:string;action:'cancel'|'retry'|'reconcile'}):Promise<OutboxItem>;
  smtpStatus(accountId:string):Promise<SmtpStatus>;
  configureSmtp(accountId:string,input:SmtpConfigure):Promise<SmtpStatus>;
  removeSmtp(accountId:string):Promise<SmtpStatus>;
  senders(accountId:string):Promise<SenderIdentity[]>;
  refreshSenders(accountId:string):Promise<SenderIdentity[]>;
  configureSender(accountId:string,input:SenderConfigure):Promise<SenderIdentity[]>;
  senderSettings(accountId:string,input:SenderSettings):Promise<SenderIdentity[]>;
  configureGraphMailbox(input:GraphMailboxInput):Promise<{accountId:string;identity:GraphMailboxIdentity}>;
  savedSearch(input:SavedSearchInput):Promise<SavedSearchResult>;
  imapDiscovery(accountId:string,after?:string):Promise<ImapDiscovery>;
  cancelImapConnection(requestId:string):Promise<void>;
  connectImap(input:ImapConnection,requestId?:string):Promise<ImapConnectionResult>;
  extractionStatus(accountId:string,input:MailExtractionRequest):Promise<MailExtractionStatus>;
  extractionRead(accountId:string,input:MailExtractionRead):Promise<MailExtractionText>;
  extractionReset(accountId:string,input:MailExtractionRequest):Promise<MailExtractionStatus>;
  draftSyncStatus(accountId:string,draftId:string):Promise<DraftSyncStatus>;
  requestDraftSync(accountId:string,input:DraftSyncRequest):Promise<DraftSyncStatus>;
  uploadDraft(accountId:string,input:MailUpload):Promise<MailUploadView>;
  saveDraft(accountId:string, input:MailDraftSave):Promise<MailDraftView>;
  readDraft(accountId:string, input:MailDraftRead):Promise<MailDraftView>;
  deleteDraft(accountId:string, input:MailDraftDelete):Promise<MailDraftSummary>;
  readDraftAttachment(accountId:string, input:MailDraftAttachment):Promise<MailDraftAttachmentView>;
  listDrafts(accountId:string, input:MailLocalPage):Promise<MailDraftPage>;
  enqueueSubmission(accountId:string, input:MailSubmission):Promise<MailLocalAction>;
  enqueueMutation(accountId:string, input:MailMutation):Promise<MailLocalAction>;
  readAction(accountId:string, actionId:string):Promise<MailLocalAction>;
  listActions(accountId:string, input:MailActionPageInput):Promise<MailActionPage>;
  cancelAction(accountId:string, input:MailActionCancel):Promise<MailLocalAction>;
  listEvents(accountId:string, input:MailEventQuery):Promise<MailEventPage>;

  search(input: MailSearchInput): Promise<MailSearchResult>;
  rebuildSearch(input: MailSearchRebuildInput): Promise<MailSearchRebuildResult>;
  status(): MailServiceStatus;
  unlock(): Promise<void>;
  lock(): Promise<void>;
  listAccounts(page: MailPageInput): Promise<MailPage<MailAccountView>>;
  listFolders(accountId: string, page: MailPageInput): Promise<MailPage<MailFolderView>>;
  listMessages(accountId: string, page: MailMessagePageInput): Promise<MailPage<MailMessageView>>;
  readMessage(accountId: string, locator: ProviderMessageLocator): Promise<MailMessageView>;
  listParts(accountId: string, locator: ProviderMessageLocator, page: MailPartPageInput): Promise<MailPage<MailPartView>>;
  readContent(accountId: string, locator: ProviderMessageLocator, request: MailContentReadInput): Promise<MailContentChunk>;
  beginConnection(provider: "gmail" | "graph", reconnectAccountId?: string, personal?: boolean): Promise<MailConnectionStarted>;
  connectionStatus(connectionId: string): Promise<MailConnectionStatus>;
  cancelConnection(connectionId: string): Promise<void>;
  disconnectAccount(accountId: string): Promise<void>;
  startSync(accountId: string): Promise<MailSyncView>;
  pauseSync(accountId: string): Promise<MailSyncView>;
  syncStatus(accountId: string): Promise<MailSyncView>;
  maintain?(operation: "rotate" | "backup" | "restore", passphrase?: string, cancellation?: AbortSignal): Promise<MailMaintenanceReport|void>;
  stop(): Promise<void>;
}
import type { MailConnectionStatus } from "./providers/connection-controller.js";
import type { MailSyncView } from "./sync-view.js";
import type { ProviderMessageLocator } from "./model.js";
import type { MailMessagePageInput, MailMessageView, MailPartPageInput, MailPartView, MailContentReadInput, MailContentChunk } from "./read-view.js";
export type MailConnectionStarted = { connectionId: string; authorizationUrl: string; expiresAt: number };
