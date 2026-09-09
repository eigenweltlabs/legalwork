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
  constructor(readonly code: "not_found" | "locked" | "unavailable" | "too_large" | "unsupported") { super(`mail_${code}`); }
}

/** Bound to one trusted owner at construction; no request supplies an owner ID. */
export interface MailService {
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
  stop(): Promise<void>;
}
import type { MailConnectionStatus } from "./providers/connection-controller.js";
import type { MailSyncView } from "./sync-view.js";
import type { ProviderMessageLocator } from "./model.js";
import type { MailMessagePageInput, MailMessageView, MailPartPageInput, MailPartView, MailContentReadInput, MailContentChunk } from "./read-view.js";
export type MailConnectionStarted = { connectionId: string; authorizationUrl: string; expiresAt: number };
