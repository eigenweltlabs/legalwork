export type MailPageInput = { limit?: number; after?: string };
export type MailAccountView = { id: string; provider: "gmail" | "graph" | "imap"; displayName: string };
export type MailFolderView = { id: string; name: string; kind: "folder" | "label"; parentId: string | null };
export type MailPage<T> = { items: T[]; nextCursor: string | null };
export type MailServiceStatus = {
  protocolVersion: 1;
  state: "locked" | "unlocking" | "ready" | "unavailable" | "locking" | "stopped";
  syncSupported: false;
};
export class MailServiceError extends Error {
  constructor(readonly code: "not_found" | "locked" | "unavailable" | "too_large") { super(`mail_${code}`); }
}

/** Bound to one trusted owner at construction; no request supplies an owner ID. */
export interface MailService {
  status(): MailServiceStatus;
  unlock(): Promise<void>;
  lock(): Promise<void>;
  listAccounts(page: MailPageInput): Promise<MailPage<MailAccountView>>;
  listFolders(accountId: string, page: MailPageInput): Promise<MailPage<MailFolderView>>;
  stop(): Promise<void>;
}
