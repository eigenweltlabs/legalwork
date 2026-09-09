import { z } from "zod";
import { providerMessageKey, providerMessageLocatorSchema } from "../model.js";
import type { MailDatabase, MailSqlRow, MailSqlValue } from "./database-interface.js";
import { MAIL_SCHEMA_VERSION } from "./schema.js";

export type MailConsistencyCode = "invalid-options" | "database-check-failed" | "sqlite-integrity-failed" |
  "foreign-key-violation" | "foreign-key-enforcement-disabled" | "schema-missing" | "schema-incomplete" | "schema-upgrade-required" | "unsupported-schema-version" |
  "invalid-account" | "invalid-message-identity" | "account-provider-mismatch" | "invalid-imap-membership" |
  "invalid-content-manifest" | "unpublished-content" | "invalid-content-reference" | "invalid-blob-publication" |
  "invalid-blob-chunks" | "scan-budget-exhausted";
export interface MailConsistencyResult {
  ok: boolean;
  scanComplete: boolean;
  scannedRows: number;
  contentHashesVerified: false;
  codes: MailConsistencyCode[];
}
const optionsSchema = z.object({
  deep: z.literal(false).default(false),
  maxRows: z.number().int().min(1).max(1_000_000).default(100_000),
  batchSize: z.number().int().min(1).max(256).default(128),
}).strict();
export type MailConsistencyOptions = z.input<typeof optionsSchema>;
const identifier = z.string().min(1).max(4096);
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
// Static identifiers only. Never interpolate provider values or schema-discovered names into SQL.
const requiredColumns: Record<string, string[]> = {
  mail_schema_version: ["singleton", "version"],
  mail_accounts: ["id", "owner_id", "provider", "display_name"],
  mail_folders: ["account_id", "id", "name", "kind", "parent_id"],
  mail_threads: ["account_id", "id"],
  mail_messages: ["account_id", "message_key", "provider", "locator_json", "rfc_message_id", "subject", "thread_id", "attachments_enumerated"],
  mail_memberships: ["account_id", "message_key", "folder_id"],
  mail_content_refs: ["account_id", "id", "bytes", "sha256"],
  mail_content_manifests: ["account_id", "message_key", "kind", "part_id", "state", "ref_id"],
  mail_cursors: ["account_id", "scope_id", "cursor"],
  mail_drafts: ["account_id", "id", "revision", "content_ref_id"],
  mail_actions: ["account_id", "id", "kind", "payload_json", "state"],
  mail_tombstones: ["account_id", "message_key", "reason", "observed_at"],
  mail_blob_objects: ["account_id", "id", "state", "bytes", "chunk_count"],
  mail_blob_chunks: ["account_id", "object_id", "ordinal", "data"],
  mail_blob_publications: ["account_id", "ref_id", "object_id"],
};

/** Worker-only diagnostic, never a migration, repair, deletion or content-download verdict.
 * Uses a synchronous snapshot and bounded keyset pages; returns fixed codes, never SQL error text or mail identifiers. */
export function checkMailConsistency(database: MailDatabase, options: MailConsistencyOptions = {}): MailConsistencyResult {
  const parsedOptions = optionsSchema.safeParse(options);
  const codes = new Set<MailConsistencyCode>();
  let scannedRows = 0;
  let scanComplete = true;
  const result = (): MailConsistencyResult => ({ ok: scanComplete && codes.size === 0, scanComplete, scannedRows, contentHashesVerified: false, codes: [...codes].sort() });
  if (!parsedOptions.success) { codes.add("invalid-options"); scanComplete = false; return result(); }
  const { maxRows, batchSize } = parsedOptions.data;
  const budget = () => {
    if (scannedRows < maxRows) return true;
    codes.add("scan-budget-exhausted"); scanComplete = false; return false;
  };
  const scan = (table: string, columns: string, keys: string[], inspect: (row: MailSqlRow) => void) => {
    let after: MailSqlValue[] | undefined;
    while (scanComplete) {
      // Fetch one extra metadata row only to distinguish exact exhaustion from a finished scan.
      const limit = Math.min(batchSize, maxRows - scannedRows + 1);
      const where = after ? `WHERE (${keys.join(",")}) > (${keys.map(() => "?").join(",")})` : "";
      const rows = database.all(`SELECT ${columns} FROM ${table} ${where} ORDER BY ${keys.join(",")} LIMIT ?`, [...(after ?? []), limit]);
      if (rows.length === 0) return;
      for (const row of rows) {
        if (!budget()) return;
        scannedRows++;
        inspect(row);
        if (!scanComplete) return;
      }
      after = keys.map(key => {
        const value = rows.at(-1)?.[key];
        if (typeof value !== "string") throw new Error("Invalid diagnostic key");
        return value;
      });
      if (rows.length < limit) return;
    }
  };
  try {
    database.transaction(() => {
      if (database.get("PRAGMA quick_check(1)")?.quick_check !== "ok") codes.add("sqlite-integrity-failed");
      if (!database.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='mail_schema_version'")) {
        codes.add("schema-missing"); scanComplete = false; return;
      }
      const version = database.get("SELECT version FROM mail_schema_version WHERE singleton=1")?.version;
      if (version === 1) { codes.add("schema-upgrade-required"); scanComplete = false; return; }
      if (version !== MAIL_SCHEMA_VERSION) { codes.add("unsupported-schema-version"); scanComplete = false; return; }
      for (const [table, columns] of Object.entries(requiredColumns)) {
        for (const column of columns) {
          if (!database.get("SELECT name FROM pragma_table_info(?) WHERE name=?", [table, column])) {
            codes.add("schema-incomplete"); scanComplete = false; return;
          }
        }
      }
      if (database.get("PRAGMA foreign_keys")?.foreign_keys !== 1) codes.add("foreign-key-enforcement-disabled");
      if (database.get("SELECT 1 AS violation FROM pragma_foreign_key_check LIMIT 1")) codes.add("foreign-key-violation");
      scan("mail_accounts", "id,owner_id,provider", ["id"], row => {
        if (!identifier.safeParse(row.id).success || !identifier.safeParse(row.owner_id).success || !["gmail", "graph", "imap"].includes(String(row.provider))) codes.add("invalid-account");
      });
      scan("mail_messages", "account_id,message_key,provider,locator_json,attachments_enumerated", ["account_id", "message_key"], row => {
        let locator;
        try { locator = providerMessageLocatorSchema.parse(JSON.parse(z.string().parse(row.locator_json))); }
        catch { codes.add("invalid-message-identity"); return; }
        if (providerMessageKey(locator) !== row.message_key) codes.add("invalid-message-identity");
        const account = database.get("SELECT provider FROM mail_accounts WHERE id=?", [z.string().parse(row.account_id)]);
        if (row.provider !== locator.provider || account?.provider !== locator.provider) codes.add("account-provider-mismatch");
        if (row.attachments_enumerated !== 0 && row.attachments_enumerated !== 1) codes.add("invalid-content-manifest");
        if (locator.provider === "imap") {
          const membership = database.get("SELECT count(*) AS count,min(folder_id) AS folder FROM mail_memberships WHERE account_id=? AND message_key=?", [z.string().parse(row.account_id), z.string().parse(row.message_key)]);
          if (membership?.count !== 1 || membership.folder !== locator.mailboxId) codes.add("invalid-imap-membership");
        }
      });
      scan("mail_content_refs", "account_id,id,bytes,sha256", ["account_id", "id"], row => {
        if (!identifier.safeParse(row.id).success || !size.safeParse(row.bytes).success || !hash.safeParse(row.sha256).success) codes.add("invalid-content-reference");
      });
      const published = (accountId: MailSqlValue, refId: MailSqlValue) => database.get(`SELECT 1 AS available FROM mail_blob_publications p
        JOIN mail_blob_objects o ON o.account_id=p.account_id AND o.id=p.object_id
        JOIN mail_content_refs r ON r.account_id=p.account_id AND r.id=p.ref_id
        WHERE p.account_id=? AND p.ref_id=? AND o.state='published' AND o.bytes=r.bytes`, [accountId, refId]);
      scan("mail_content_manifests", "account_id,message_key,kind,part_id,state,ref_id", ["account_id", "message_key", "kind", "part_id"], row => {
        const validKind = ["raw", "body", "attachment"].includes(String(row.kind));
        const validPart = typeof row.part_id === "string" && ((row.kind === "attachment") === (row.part_id.length > 0));
        const validState = ["pending", "stored", "unavailable"].includes(String(row.state)) && ((row.state === "stored") === (typeof row.ref_id === "string"));
        if (!validKind || !validPart || !validState || (row.state !== "stored" && row.ref_id !== null)) codes.add("invalid-content-manifest");
        if (row.state === "stored" && (typeof row.ref_id !== "string" || !published(z.string().parse(row.account_id), row.ref_id))) codes.add("unpublished-content");
      });
      scan("mail_drafts", "account_id,id,content_ref_id", ["account_id", "id"], row => {
        if (row.content_ref_id !== null && !published(z.string().parse(row.account_id), z.string().parse(row.content_ref_id))) codes.add("unpublished-content");
      });
      scan("mail_blob_objects", "account_id,id,state,bytes,chunk_count", ["account_id", "id"], row => {
        const accountId = z.string().parse(row.account_id);
        const objectId = z.string().parse(row.id);
        const publication = database.get(`SELECT r.bytes,r.sha256,p.ref_id FROM mail_blob_publications p
          LEFT JOIN mail_content_refs r ON r.account_id=p.account_id AND r.id=p.ref_id WHERE p.account_id=? AND p.object_id=?`, [accountId, objectId]);
        if (row.state === "staging" && !publication) return; // Interrupted staging is recoverable, not claimed complete.
        if (row.state !== "published" || !publication || !size.safeParse(row.bytes).success || !size.safeParse(row.chunk_count).success ||
            publication.bytes !== row.bytes || !hash.safeParse(publication.sha256).success || publication.ref_id !== `sha256:${String(publication.sha256)}`) {
          codes.add("invalid-blob-publication"); return;
        }
        const expectedBytes = size.parse(row.bytes);
        const expectedChunks = size.parse(row.chunk_count);
        if (expectedChunks !== Math.ceil(expectedBytes / 65536)) { codes.add("invalid-blob-chunks"); return; }
        let ordinal = 0;
        let bytes = 0;
        let after = -1;
        while (scanComplete) {
          const limit = Math.min(batchSize, maxRows - scannedRows + 1);
          const chunks = database.all("SELECT ordinal,length(data) AS bytes FROM mail_blob_chunks WHERE account_id=? AND object_id=? AND ordinal>? ORDER BY ordinal LIMIT ?", [accountId, objectId, after, limit]);
          if (chunks.length === 0) break;
          for (const chunk of chunks) {
            if (!budget()) return;
            scannedRows++;
            if (chunk.ordinal !== ordinal || chunk.bytes !== Math.min(65536, expectedBytes - bytes)) codes.add("invalid-blob-chunks");
            if (!size.safeParse(chunk.ordinal).success || !size.safeParse(chunk.bytes).success) { codes.add("invalid-blob-chunks"); return; }
            after = size.parse(chunk.ordinal); bytes += size.parse(chunk.bytes); ordinal++;
          }
          if (chunks.length < limit) break;
        }
        if (ordinal !== expectedChunks || bytes !== expectedBytes) codes.add("invalid-blob-chunks");
      });
    });
  } catch {
    codes.add("database-check-failed"); scanComplete = false;
  }
  return result();
}
