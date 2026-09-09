import { z } from "zod";
import { providerMessageKey, providerMessageLocatorSchema, type ProviderMessageLocator } from "../model.js";
import type { MailDatabase } from "./database-interface.js";

const id = z.string().min(1).max(4096);
const provider = z.enum(["gmail", "graph", "imap"]);
const accountInput = z.object({ id, provider, displayName: z.string() }).strict();
const folderInput = z.object({ id, name: z.string(), kind: z.enum(["folder", "label"]), parentId: id.nullable().default(null) }).strict();
const messageInput = z.object({
  locator: providerMessageLocatorSchema, rfcMessageId: z.string().nullable(), subject: z.string(),
  threadId: id.nullable().default(null), memberships: z.array(id),
}).strict();
const contentInput = z.object({
  kind: z.enum(["raw", "body", "attachment"]), partId: z.string().max(4096).default(""),
  state: z.enum(["pending", "stored", "unavailable"]),
  reference: z.object({ id, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "attachment") !== (value.partId.length > 0)) ctx.addIssue({ code: "custom", message: "Only attachment parts require a part ID" });
  if ((value.state === "stored") !== (value.reference !== undefined)) ctx.addIssue({ code: "custom", message: "Only stored content requires a durable reference" });
});
const pageInput = z.object({ limit: z.number().int().min(1).max(100).default(50), after: id.optional() }).strict();
const folderRow = z.object({ id, name: z.string(), kind: z.enum(["folder", "label"]), parent_id: id.nullable() });
export type MailPageInput = z.input<typeof pageInput>;

const accountRow = z.object({ id, owner_id: id, provider, display_name: z.string() });
const messageRow = z.object({ account_id: id, message_key: z.string().min(1), provider, locator_json: z.string(), rfc_message_id: z.string().nullable(), subject: z.string(), thread_id: id.nullable(), attachments_enumerated: z.union([z.literal(0), z.literal(1)]) });
const manifestRow = z.object({ kind: z.enum(["raw", "body", "attachment"]), part_id: z.string(), state: z.enum(["pending", "stored", "unavailable"]), ref_id: id.nullable(), bytes: z.number().nullable(), sha256: z.string().nullable(), bytes_available: z.union([z.literal(0), z.literal(1)]) });

export type MailAccountInput = z.input<typeof accountInput>;
export type MailFolderInput = z.input<typeof folderInput>;
export type MailMessageInput = z.input<typeof messageInput>;
export type MailContentInput = z.input<typeof contentInput>;

/** Owner scope is established by the service, never by an untrusted request body.
 * Receives an already migrated encrypted database; this module never opens a file. */
export class MailRepository {
  private readonly ownerId: string;
  constructor(private readonly database: MailDatabase, ownerId: string) { this.ownerId = id.parse(ownerId); }

  private account(accountId: string) {
    const row = this.database.get("SELECT * FROM mail_accounts WHERE id=? AND owner_id=?", [id.parse(accountId), this.ownerId]);
    if (!row) throw new Error("Mail account not found");
    return accountRow.parse(row);
  }
  createAccount(input: MailAccountInput): void {
    const value = accountInput.parse(input);
    this.database.run("INSERT INTO mail_accounts(id,owner_id,provider,display_name) VALUES(?,?,?,?)", [value.id, this.ownerId, value.provider, value.displayName]);
  }
  listAccounts() {
    return this.database.all("SELECT * FROM mail_accounts WHERE owner_id=? ORDER BY id", [this.ownerId]).map(row => accountRow.parse(row));
  }
  /** Keyset pagination is bounded in SQL, including one look-ahead row. */
  listAccountsPage(input: MailPageInput = {}) {
    const page = pageInput.parse(input);
    const items = this.database.all(
      "SELECT id,owner_id,provider,display_name FROM mail_accounts WHERE owner_id=? AND id>? ORDER BY id LIMIT ?",
      [this.ownerId, page.after ?? "", page.limit + 1],
    ).map(row => accountRow.parse(row));
    return { items: items.slice(0, page.limit), hasMore: items.length > page.limit };
  }
  listFoldersPage(accountId: string, input: MailPageInput = {}) {
    this.account(accountId);
    const page = pageInput.parse(input);
    const items = this.database.all(
      "SELECT id,name,kind,parent_id FROM mail_folders WHERE account_id=? AND id>? ORDER BY id LIMIT ?",
      [accountId, page.after ?? "", page.limit + 1],
    ).map(row => folderRow.parse(row));
    return { items: items.slice(0, page.limit), hasMore: items.length > page.limit };
  }
  putFolder(accountId: string, input: MailFolderInput): void {
    this.account(accountId);
    const value = folderInput.parse(input);
    if (value.parentId !== null && this.database.get(`WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM mail_folders WHERE account_id=? AND id=?
      UNION SELECT f.id,f.parent_id FROM mail_folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.account_id=?
    ) SELECT id FROM ancestors WHERE id=?`, [accountId, value.parentId, accountId, value.id])) throw new Error("Folder hierarchy cycle");
    this.database.run("INSERT INTO mail_folders(account_id,id,name,kind,parent_id) VALUES(?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name,kind=excluded.kind,parent_id=excluded.parent_id", [accountId, value.id, value.name, value.kind, value.parentId]);
  }
  listFolders(accountId: string) {
    this.account(accountId);
    return this.database.all("SELECT id,name,kind,parent_id FROM mail_folders WHERE account_id=? ORDER BY id", [accountId]);
  }
  /** Memberships are a complete snapshot for this provider identity. Raw content survives metadata updates. */
  ingestMessage(accountId: string, input: MailMessageInput): string {
    const account = this.account(accountId);
    const value = messageInput.parse(input);
    if (account.provider !== value.locator.provider) throw new Error("Provider identity does not match account");
    if (value.locator.provider === "imap" && (value.memberships.length !== 1 || value.memberships[0] !== value.locator.mailboxId)) throw new Error("IMAP identity requires its own mailbox membership");
    const key = providerMessageKey(value.locator);
    this.database.transaction(() => {
      if (value.threadId !== null) this.database.run("INSERT INTO mail_threads(account_id,id) VALUES(?,?) ON CONFLICT DO NOTHING", [accountId, value.threadId]);
      this.database.run(`INSERT INTO mail_messages(account_id,message_key,provider,locator_json,rfc_message_id,subject,thread_id) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(account_id,message_key) DO UPDATE SET rfc_message_id=excluded.rfc_message_id,subject=excluded.subject,thread_id=excluded.thread_id`,
      [accountId, key, value.locator.provider, JSON.stringify(value.locator), value.rfcMessageId, value.subject, value.threadId]);
      this.database.run("DELETE FROM mail_memberships WHERE account_id=? AND message_key=?", [accountId, key]);
      for (const folder of new Set(value.memberships)) this.database.run("INSERT INTO mail_memberships(account_id,message_key,folder_id) VALUES(?,?,?)", [accountId, key, folder]);
    });
    return key;
  }
  /** Caller supplies refs only AFTER durable encrypted content exists. No bytes are accepted here. */
  putContent(accountId: string, locator: ProviderMessageLocator, input: MailContentInput): void {
    this.account(accountId);
    const key = providerMessageKey(locator);
    const value = contentInput.parse(input);
    this.database.transaction(() => {
      if (value.reference) {
        const reference = value.reference;
        const existing = this.database.get("SELECT bytes,sha256 FROM mail_content_refs WHERE account_id=? AND id=?", [accountId, reference.id]);
        if (existing && (existing.bytes !== reference.bytes || existing.sha256 !== reference.sha256)) throw new Error("Durable content reference cannot change");
        this.database.run("INSERT INTO mail_content_refs(account_id,id,bytes,sha256) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", [accountId, reference.id, reference.bytes, reference.sha256]);
      }
      this.database.run(`INSERT INTO mail_content_manifests(account_id,message_key,kind,part_id,state,ref_id) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id,message_key,kind,part_id) DO UPDATE SET state=excluded.state,ref_id=excluded.ref_id`,
      [accountId, key, value.kind, value.partId, value.state, value.reference?.id ?? null]);
    });
  }
  setAttachmentsEnumerated(accountId: string, locator: ProviderMessageLocator, complete: boolean): void {
    this.account(accountId);
    const result = this.database.run("UPDATE mail_messages SET attachments_enumerated=? WHERE account_id=? AND message_key=?", [z.boolean().parse(complete) ? 1 : 0, accountId, providerMessageKey(locator)]);
    if (result.changes !== 1) throw new Error("Mail message not found");
  }
  readMessage(accountId: string, locator: ProviderMessageLocator) {
    this.account(accountId);
    const key = providerMessageKey(locator);
    const raw = this.database.get("SELECT * FROM mail_messages WHERE account_id=? AND message_key=?", [accountId, key]);
    if (!raw) return undefined;
    const message = messageRow.parse(raw);
    const memberships = this.database.all("SELECT folder_id FROM mail_memberships WHERE account_id=? AND message_key=? ORDER BY folder_id", [accountId, key]).map(row => id.parse(row.folder_id));
    const content = this.database.all(`SELECT m.kind,m.part_id,m.state,m.ref_id,r.bytes,r.sha256,
      CASE WHEN o.state='published' AND o.bytes=r.bytes
        AND o.chunk_count=(r.bytes / 65536 + CASE WHEN r.bytes % 65536 > 0 THEN 1 ELSE 0 END)
        THEN 1 ELSE 0 END AS bytes_available
      FROM mail_content_manifests m
      LEFT JOIN mail_content_refs r ON r.account_id=m.account_id AND r.id=m.ref_id
      LEFT JOIN mail_blob_publications p ON p.account_id=r.account_id AND p.ref_id=r.id
      LEFT JOIN mail_blob_objects o ON o.account_id=p.account_id AND o.id=p.object_id
      WHERE m.account_id=? AND m.message_key=? ORDER BY m.kind,m.part_id`, [accountId, key]).map(row => {
      const { bytes_available, ...part } = manifestRow.parse(row);
      return { ...part, bytesAvailable: bytes_available === 1 };
    });
    // A legacy stored manifest is not an attestation that this database has its bytes.
    const unavailable = content.some(part => part.state === "unavailable" || (part.state === "stored" && !part.bytesAvailable));
    const complete = message.attachments_enumerated === 1 && content.some(part => part.kind === "raw" && part.state === "stored") &&
      content.some(part => part.kind === "body" && part.state === "stored") && content.every(part => part.state === "stored" && part.bytesAvailable);
    const contentState: "attention" | "complete" | "downloading" = unavailable ? "attention" : complete ? "complete" : "downloading";
    return { ...message, locator: providerMessageLocatorSchema.parse(JSON.parse(message.locator_json)), memberships, content, contentState };
  }
}
