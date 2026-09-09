import type {ImapDiscovery,ImapConnection,ImapConnectionResult} from './providers/imap-config.js';
import type { MailActionCancel, MailActionPage, MailDraftAttachment, MailDraftAttachmentView, MailDraftDelete, MailDraftPage, MailDraftRead, MailDraftSave, MailDraftSummary, MailDraftView, MailEventPage, MailEventQuery, MailLocalAction, MailLocalPage, MailMutation, MailSubmission } from "./local-view.js";
import type { MailSearchInput, MailSearchResult, MailSearchRebuildInput, MailSearchRebuildResult } from "./search-view.js";
export type MailPageInput = { limit?: number; after?: string };
export type MailAccountView = { id: string; provider: "gmail" | "graph" | "imap"; displayName: string };
export type MailFolderView = { id: string; name: string; kind: "folder" | "label"; parentId: string | null };
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
  imapDiscovery(accountId:string,after?:string):Promise<ImapDiscovery>;
  connectImap(input:ImapConnection):Promise<ImapConnectionResult>;
  saveDraft(accountId:string, input:MailDraftSave):Promise<MailDraftView>;
  readDraft(accountId:string, input:MailDraftRead):Promise<MailDraftView>;
  deleteDraft(accountId:string, input:MailDraftDelete):Promise<MailDraftSummary>;
  readDraftAttachment(accountId:string, input:MailDraftAttachment):Promise<MailDraftAttachmentView>;
  listDrafts(accountId:string, input:MailLocalPage):Promise<MailDraftPage>;
  enqueueSubmission(accountId:string, input:MailSubmission):Promise<MailLocalAction>;
  enqueueMutation(accountId:string, input:MailMutation):Promise<MailLocalAction>;
  readAction(accountId:string, actionId:string):Promise<MailLocalAction>;
  listActions(accountId:string, input:MailLocalPage):Promise<MailActionPage>;
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
  beginConnection(provider: "gmail" | "graph", reconnectAccountId?: string): Promise<MailConnectionStarted>;
  connectionStatus(connectionId: string): Promise<MailConnectionStatus>;
  cancelConnection(connectionId: string): Promise<void>;
  disconnectAccount(accountId: string): Promise<void>;
  startSync(accountId: string): Promise<MailSyncView>;
  pauseSync(accountId: string): Promise<MailSyncView>;
  syncStatus(accountId: string): Promise<MailSyncView>;
  maintain?(operation: "rotate" | "backup" | "restore", passphrase?: string): Promise<void>;
  stop(): Promise<void>;
}
import type { MailConnectionStatus } from "./providers/connection-controller.js";
import type { MailSyncView } from "./sync-view.js";
import type { ProviderMessageLocator } from "./model.js";
import type { MailMessagePageInput, MailMessageView, MailPartPageInput, MailPartView, MailContentReadInput, MailContentChunk } from "./read-view.js";
export type MailConnectionStarted = { connectionId: string; authorizationUrl: string; expiresAt: number };
