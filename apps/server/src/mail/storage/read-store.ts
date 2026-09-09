import { z } from "zod";
import { providerMessageLocatorSchema, type ProviderMessageLocator } from "../model.js";
import { mailMessagePageSchema, mailMessageViewSchema, mailPartPageSchema, mailPartViewSchema, mailContentReadSchema,
  type MailMessagePageInput, type MailPartPageInput, type MailContentReadInput } from "../read-view.js";
import { MailRepository } from "./repository.js";
import { graphAttachmentSchema } from "../providers/graph.js";
import { mimeMetadataSchema } from "./mime-projection-store.js";
import { MailContentStore } from "./content-store.js";
import type { MailDatabase } from "./database-interface.js";

/** Owner-bound offline reads. Credential/archive access is additionally gated by the worker. */
export class MailReadStore {
  private readonly repository: MailRepository;
  private readonly content: MailContentStore;
  constructor(private readonly database: MailDatabase, ownerId: string) {
    this.repository = new MailRepository(database, ownerId);
    this.content = new MailContentStore(database, ownerId);
  }
  private message(accountId: string, locator: ProviderMessageLocator) {
    const message = this.repository.readMessage(accountId, locator);
    if (!message) throw new Error("Mail message not found");
    return message;
  }
  read(accountId: string, locator: ProviderMessageLocator) {
    const message = this.message(accountId, locator);
    const row = this.database.get(`SELECT p.metadata_json FROM mail_mime_projections p JOIN mail_content_manifests m
      ON m.account_id=p.account_id AND m.message_key=p.message_key AND m.ref_id=p.raw_ref_id
      WHERE p.account_id=? AND p.message_key=? AND p.state='complete' AND m.kind='raw' AND m.state='stored'`, [accountId, message.message_key]);
    const metadata = typeof row?.metadata_json === "string" ? z.object({ metadata: mimeMetadataSchema }).parse(JSON.parse(row.metadata_json)).metadata : null;
    const removed = !!this.database.get("SELECT 1 FROM mail_tombstones WHERE account_id=? AND message_key=?", [accountId, message.message_key]);
    return mailMessageViewSchema.parse({ accountId, key: message.message_key, locator: message.locator, subject: message.subject,
      rfcMessageId: message.rfc_message_id, threadId: message.thread_id, memberships: message.memberships, removed, contentState: message.contentState, metadata });
  }
  list(accountId: string, supplied: MailMessagePageInput) {
    // This bounded owner check precedes cursor/filter handling and every result query.
    this.repository.listFoldersPage(accountId, { limit: 1 });
    const page = mailMessagePageSchema.parse(supplied);
    const rows = this.database.all(`SELECT m.message_key,m.locator_json FROM mail_messages m
      WHERE m.account_id=? AND m.message_key>? AND (?=1 OR NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.account_id=m.account_id AND t.message_key=m.message_key))
      AND (? IS NULL OR m.thread_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM mail_memberships f WHERE f.account_id=m.account_id AND f.message_key=m.message_key AND f.folder_id=?))
      ORDER BY m.message_key LIMIT ?`, [accountId, page.after ?? "", page.includeRemoved ? 1 : 0, page.threadId ?? null, page.threadId ?? null, page.folderId ?? null, page.folderId ?? null, page.limit + 1]);
    const items = rows.slice(0, page.limit).map(row => {
      if (typeof row.locator_json !== "string") throw new Error("Invalid stored locator");
      return this.read(accountId, providerMessageLocatorSchema.parse(JSON.parse(row.locator_json)));
    });
    return { accountId, items, nextCursor: rows.length > page.limit ? items.at(-1)?.key ?? null : null };
  }
  parts(accountId: string, locator: ProviderMessageLocator, supplied: MailPartPageInput) {
    const message = this.message(accountId, locator), page = mailPartPageSchema.parse(supplied);
    const parts = message.content.map(part => {
      const raw = this.database.get(`SELECT p.metadata_json FROM mail_mime_parts p JOIN mail_content_manifests m
        ON m.account_id=p.account_id AND m.message_key=p.message_key AND m.ref_id=p.raw_ref_id
        WHERE p.account_id=? AND p.message_key=? AND p.part_id=? AND m.kind='raw' AND m.state='stored'`, [accountId, message.message_key, part.part_id]);
      let metadata = typeof raw?.metadata_json === "string" ? z.object({ filename: z.string().nullable(), contentType: z.string(), contentId: z.string().nullable() }).parse(JSON.parse(raw.metadata_json)) : null;
      if (!metadata && locator.provider === "graph" && part.part_id.startsWith("graph:")) {
        const native = this.database.get(`SELECT a.metadata_json FROM mail_graph_attachments a JOIN mail_content_manifests m ON m.account_id=a.account_id AND m.message_key=a.message_key AND m.ref_id=a.raw_ref_id
          WHERE a.account_id=? AND a.message_key=? AND a.id=? AND m.kind='raw' AND m.state='stored'`, [accountId,message.message_key,part.part_id.slice(6)]);
        if (typeof native?.metadata_json === "string") { const value=graphAttachmentSchema.parse(JSON.parse(native.metadata_json)); metadata={filename:value.name,contentType:value.contentType??"application/octet-stream",contentId:value.contentId??null}; }
      }
      return mailPartViewSchema.parse({ key: JSON.stringify([part.kind, part.part_id]), kind: part.kind, partId: part.part_id,
        state: part.state, referenceId: part.ref_id, bytes: part.bytes, sha256: part.sha256, bytesAvailable: part.bytesAvailable,
        filename: metadata?.filename ?? null, contentType: metadata?.contentType ?? (part.kind === "raw" ? "message/rfc822" : part.kind === "body" ? "application/json" : null), contentId: metadata?.contentId ?? null });
    }).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).filter(part => page.after === undefined || part.key > page.after);
    const items = parts.slice(0, page.limit);
    return { accountId, locator, items, nextCursor: parts.length > page.limit ? items.at(-1)?.key ?? null : null };
  }
  chunk(accountId: string, locator: ProviderMessageLocator, supplied: MailContentReadInput) {
    const message = this.message(accountId, locator), request = mailContentReadSchema.parse(supplied);
    const part = message.content.find(item => item.kind === request.kind && item.part_id === request.partId && item.ref_id === request.referenceId);
    if (!part || !part.bytesAvailable) throw new Error("Mail content not found");
    const chunk = this.content.readRange(accountId, request.referenceId, request.offset, request.limit);
    return { accountId, locator, referenceId: request.referenceId, offset: request.offset, ...chunk };
  }
}
