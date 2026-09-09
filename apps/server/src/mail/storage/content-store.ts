import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { providerMessageKey, type ProviderMessageLocator } from "../model.js";
import type { MailDatabase } from "./database-interface.js";
import { MailRepository } from "./repository.js";

export const MAIL_CONTENT_CHUNK_BYTES = 64 * 1024;
const id = z.string().min(1).max(4096);
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const writeOptions = z.object({
  kind: z.enum(["raw", "body", "attachment"]), partId: z.string().max(4096).default(""),
  maxBytes: size, expectedBytes: size.optional(), expectedSha256: hash.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "attachment") !== (value.partId.length > 0)) ctx.addIssue({ code: "custom", message: "Only attachments require a part ID" });
  if (value.expectedBytes !== undefined && value.expectedBytes > value.maxBytes) ctx.addIssue({ code: "custom", message: "Expected size exceeds byte limit" });
});
const objectRow = z.object({ id, state: z.enum(["staging", "published"]), bytes: size, chunk_count: size });
const publicationRow = z.object({ object_id: id, bytes: size, sha256: hash, chunk_count: size });
export type MailContentWriteOptions = z.input<typeof writeOptions>;
export interface MailContentReference { id: string; bytes: number; sha256: string }

/** Uses ONLY the injected encrypted database. Caller establishes the owner scope.
 * No network, filesystem blobs, eager buffering or published-content garbage collection. */
export class MailContentStore {
  private readonly ownerId: string;
  private readonly repository: MailRepository;
  constructor(private readonly database: MailDatabase, ownerId: string) {
    this.ownerId = id.parse(ownerId);
    this.repository = new MailRepository(database, this.ownerId);
  }
  private account(accountId: string): void {
    if (!this.database.get("SELECT id FROM mail_accounts WHERE id=? AND owner_id=?", [id.parse(accountId), this.ownerId])) throw new Error("Mail account not found");
  }
  private append(accountId: string, stageId: string, chunk: Uint8Array): void {
    this.database.transaction(() => {
      const stage = objectRow.parse(this.database.get("SELECT id,state,bytes,chunk_count FROM mail_blob_objects WHERE account_id=? AND id=?", [accountId, stageId]));
      if (stage.state !== "staging") throw new Error("Content is not staged");
      this.database.run("INSERT INTO mail_blob_chunks(account_id,object_id,ordinal,data) VALUES(?,?,?,?)", [accountId, stageId, stage.chunk_count, chunk]);
      this.database.run("UPDATE mail_blob_objects SET bytes=bytes+?,chunk_count=chunk_count+1 WHERE account_id=? AND id=?", [chunk.byteLength, accountId, stageId]);
    });
  }

  /** Source chunks MUST be Uint8Arrays <=64 KiB. The writer owns one 64 KiB buffer.
   * The final transaction alone changes the manifest; a failed refresh retains its old part.
   * An optional trusted synchronous callback can fence credentials/leases and commit job success
   * in that same transaction. It must not perform network I/O or retain mutable store access. */
  async writePart(accountId: string, locator: ProviderMessageLocator, options: MailContentWriteOptions,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, onPublish?: (reference: Readonly<MailContentReference>) => unknown): Promise<MailContentReference> {
    if (onPublish !== undefined && (typeof onPublish !== "function" || Object.prototype.toString.call(onPublish) === "[object AsyncFunction]")) throw new Error("Content publication callback must be synchronous");
    this.account(accountId);
    const key = providerMessageKey(locator);
    const value = writeOptions.parse(options);
    if (!this.database.get("SELECT message_key FROM mail_messages WHERE account_id=? AND message_key=?", [accountId, key])) throw new Error("Mail message not found");
    const stageId = randomUUID();
    this.database.run("INSERT INTO mail_blob_objects(account_id,id,state) VALUES(?,?,'staging')", [accountId, stageId]);
    try {
      const digest = createHash("sha256");
      const buffer = new Uint8Array(MAIL_CONTENT_CHUNK_BYTES);
      let buffered = 0;
      let bytes = 0;
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAIL_CONTENT_CHUNK_BYTES) throw new Error("Source chunks must be Uint8Arrays no larger than 64 KiB");
        if (chunk.byteLength > value.maxBytes - bytes || (value.expectedBytes !== undefined && chunk.byteLength > value.expectedBytes - bytes)) throw new Error("Content exceeds declared byte limit");
        bytes += chunk.byteLength;
        digest.update(chunk);
        for (let offset = 0; offset < chunk.byteLength;) {
          const amount = Math.min(buffer.length - buffered, chunk.byteLength - offset);
          buffer.set(chunk.subarray(offset, offset + amount), buffered);
          offset += amount;
          buffered += amount;
          if (buffered === buffer.length) { this.append(accountId, stageId, buffer); buffered = 0; }
        }
      }
      if (value.expectedBytes !== undefined && bytes !== value.expectedBytes) throw new Error("Content size does not match expectation");
      const sha256 = digest.digest("hex");
      if (value.expectedSha256 !== undefined && sha256 !== value.expectedSha256) throw new Error("Content hash does not match expectation");
      if (buffered > 0) this.append(accountId, stageId, buffer.subarray(0, buffered));
      const reference = { id: `sha256:${sha256}`, bytes, sha256 };
      this.database.transaction(() => {
        this.account(accountId);
        const stage = objectRow.parse(this.database.get("SELECT id,state,bytes,chunk_count FROM mail_blob_objects WHERE account_id=? AND id=?", [accountId, stageId]));
        if (stage.state !== "staging" || stage.bytes !== bytes || stage.chunk_count !== Math.ceil(bytes / MAIL_CONTENT_CHUNK_BYTES)) throw new Error("Incomplete staged content");
        // Read back staged bytes incrementally before making any completeness claim.
        for (const _chunk of this.readObject(accountId, stageId, bytes, stage.chunk_count, sha256)) { /* verify through EOF */ }
        // This nested transaction/savepoint remains inside the atomic publication commit.
        this.repository.putContent(accountId, locator, { kind: value.kind, partId: value.partId, state: "stored", reference });
        const existing = this.database.get("SELECT object_id FROM mail_blob_publications WHERE account_id=? AND ref_id=?", [accountId, reference.id]);
        if (existing) {
          for (const _chunk of this.read(accountId, reference.id)) { /* verify dedup target through EOF */ }
          this.discardStaging(accountId, stageId); // Same-account dedup; never delete the published object.
        } else {
          this.database.run("UPDATE mail_blob_objects SET state='published' WHERE account_id=? AND id=?", [accountId, stageId]);
          this.database.run("INSERT INTO mail_blob_publications(account_id,ref_id,object_id) VALUES(?,?,?)", [accountId, reference.id, stageId]);
        }
        // A savepoint rejects thenables and rolls back both callback writes and publication.
        if (onPublish) this.database.transaction(() => onPublish(Object.freeze({ ...reference })));
      });
      return reference;
    } catch (error) {
      // Disk-full may prevent cleanup too. Leave recoverable staging, preserving the original error.
      try { this.discardStaging(accountId, stageId); } catch { /* explicit cleanup after recovery */ }
      throw error;
    }
  }

  /** Bounded reads verify aggregate byte/hash integrity at EOF. Consumers must finish
   * the iterator before treating the entire content as verified. No all-chunk query. */
  *read(accountId: string, referenceId: string): IterableIterator<Uint8Array> {
    this.account(accountId);
    const raw = this.database.get(`SELECT p.object_id,r.bytes,r.sha256,o.chunk_count FROM mail_blob_publications p
      JOIN mail_content_refs r ON r.account_id=p.account_id AND r.id=p.ref_id
      JOIN mail_blob_objects o ON o.account_id=p.account_id AND o.id=p.object_id
      WHERE p.account_id=? AND p.ref_id=? AND o.state='published'`, [accountId, id.parse(referenceId)]);
    if (!raw) throw new Error("Durable content bytes are unavailable");
    const publication = publicationRow.parse(raw);
    yield* this.readObject(accountId, publication.object_id, publication.bytes, publication.chunk_count, publication.sha256);
  }
  private *readObject(accountId: string, objectId: string, expectedBytes: number, chunkCount: number, expectedHash: string): IterableIterator<Uint8Array> {
    if (chunkCount !== Math.ceil(expectedBytes / MAIL_CONTENT_CHUNK_BYTES)) throw new Error("Invalid durable chunk count");
    const digest = createHash("sha256");
    let bytes = 0;
    for (let ordinal = 0; ordinal < chunkCount; ordinal++) {
      const row = this.database.get("SELECT data FROM mail_blob_chunks WHERE account_id=? AND object_id=? AND ordinal=?", [accountId, objectId, ordinal]);
      const chunk = row?.data;
      const expectedLength = Math.min(MAIL_CONTENT_CHUNK_BYTES, expectedBytes - bytes);
      if (!(chunk instanceof Uint8Array) || chunk.byteLength !== expectedLength) throw new Error("Durable content chunk is missing or invalid");
      digest.update(chunk);
      bytes += chunk.byteLength;
      yield chunk;
    }
    if (bytes !== expectedBytes || digest.digest("hex") !== expectedHash) throw new Error("Durable content integrity check failed");
  }

  /** Explicit recovery only; callers must quiesce writers before clearing their stages. */
  listStaging(accountId: string, limit = 100) {
    this.account(accountId);
    const bounded = z.number().int().min(1).max(1000).parse(limit);
    return this.database.all("SELECT id,state,bytes,chunk_count FROM mail_blob_objects WHERE account_id=? AND state='staging' ORDER BY id LIMIT ?", [accountId, bounded]).map(row => objectRow.parse(row));
  }
  /** Publication references block deletion even if an internal state flag was corrupted. */
  discardStaging(accountId: string, stageId: string): boolean {
    this.account(accountId);
    return this.database.run(`DELETE FROM mail_blob_objects WHERE account_id=? AND id=? AND state='staging'
      AND NOT EXISTS (SELECT 1 FROM mail_blob_publications p WHERE p.account_id=mail_blob_objects.account_id AND p.object_id=mail_blob_objects.id)`, [accountId, id.parse(stageId)]).changes === 1;
  }
}
