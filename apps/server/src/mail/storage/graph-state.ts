import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MailDatabase } from "./database-interface.js";
import { MailRepository } from "./repository.js";
import { providerMessageKey } from "../model.js";
import { graphMessageSchema, graphAttachmentSchema, type GraphMessage, type GraphAttachment } from "../providers/graph.js";
export const GRAPH_SCHEMA_SQL = `
 CREATE TABLE mail_graph_runs(account_id TEXT PRIMARY KEY,generation TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN ('active','paused','complete','attention')),failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),retry_at INTEGER CHECK(retry_at BETWEEN 0 AND 9007199254740991),error TEXT,FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
 CREATE TABLE mail_graph_folder_queue(account_id TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 33),metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),cursor TEXT,done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),error TEXT,PRIMARY KEY(account_id,id),FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
 CREATE INDEX mail_graph_folder_pending ON mail_graph_folder_queue(account_id,done,depth,id);
 CREATE TABLE mail_graph_messages(account_id TEXT NOT NULL,message_key TEXT NOT NULL,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),raw_change_key TEXT,parts_complete INTEGER NOT NULL DEFAULT 0 CHECK(parts_complete IN (0,1)),error TEXT,PRIMARY KEY(account_id,message_key),FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key));
 CREATE TABLE mail_graph_attachments(account_id TEXT NOT NULL,message_key TEXT NOT NULL,id TEXT NOT NULL,raw_ref_id TEXT NOT NULL,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),ref_id TEXT,error TEXT,PRIMARY KEY(account_id,message_key,id),FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key),FOREIGN KEY(account_id,raw_ref_id) REFERENCES mail_content_refs(account_id,id),FOREIGN KEY(account_id,ref_id) REFERENCES mail_content_refs(account_id,id));
 CREATE TRIGGER mail_graph_attachment_search_INSERT AFTER INSERT ON mail_graph_attachments BEGIN INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT DO NOTHING; END;
 CREATE TRIGGER mail_graph_attachment_search_UPDATE AFTER UPDATE ON mail_graph_attachments BEGIN INSERT INTO mail_search_dirty(account_id,message_key) SELECT NEW.account_id,NEW.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=NEW.account_id AND message_key=NEW.message_key) ON CONFLICT DO NOTHING; END;
 CREATE TRIGGER mail_graph_attachment_search_DELETE AFTER DELETE ON mail_graph_attachments BEGIN INSERT INTO mail_search_dirty(account_id,message_key) SELECT OLD.account_id,OLD.message_key WHERE EXISTS(SELECT 1 FROM mail_messages WHERE account_id=OLD.account_id AND message_key=OLD.message_key) ON CONFLICT DO NOTHING; END;
`;
const id = z.string().min(1).max(4096), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runSchema = z.object({ account_id: id, generation: id, revision: count, state: z.enum(["active", "paused", "complete", "attention"]), failures: count, retry_at: count.nullable(), error: z.string().nullable() });
export type GraphRun = z.infer<typeof runSchema>;
export type GraphIssue = "protected_or_inaccessible" | "reference_attachment" | "message_unavailable" | "content_incomplete" | "provider_unavailable" | "reconsent_required" | "storage_unavailable";
export class GraphState {
    readonly repository: MailRepository;
    constructor(readonly db: MailDatabase, readonly ownerId: string) { id.parse(ownerId); this.repository = new MailRepository(db, ownerId); }
    account(accountId: string) { if (!this.db.get("SELECT 1 FROM mail_accounts WHERE owner_id=? AND id=? AND provider='graph'", [this.ownerId, id.parse(accountId)]))
        throw new Error("Mail account not found"); }
    read(accountId: string) { this.account(accountId); const row = this.db.get("SELECT * FROM mail_graph_runs WHERE account_id=?", [accountId]); return row ? runSchema.parse(row) : null; }
    start(accountId: string) {
        return this.db.transaction(() => {
            this.account(accountId);
            const old = this.read(accountId);
            if (old?.state === "complete")
                return old;
            this.db.run("INSERT INTO mail_graph_runs(account_id,generation,revision,state) VALUES(?,?,1,'active') ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,state='active'", [accountId, randomUUID()]);
            this.db.run("INSERT INTO mail_graph_folder_queue(account_id,id,parent_id,depth) VALUES(?,'',NULL,0) ON CONFLICT DO NOTHING", [accountId]);
            return runSchema.parse(this.db.get("SELECT * FROM mail_graph_runs WHERE account_id=?", [accountId]));
        });
    }
    assert(run: GraphRun) { const now = this.read(run.account_id); if (!now || now.state !== "active" || now.generation !== run.generation || now.revision !== run.revision)
        throw new Error("mail_graph_stale_run"); }
    update(run: GraphRun, state: GraphRun["state"], error: string | null = null, retryAt: number | null = null, failures = 0) { return this.db.transaction(() => { this.assert(run); this.db.run("UPDATE mail_graph_runs SET state=?,revision=revision+1,error=?,retry_at=?,failures=? WHERE account_id=?", [state, error, retryAt, failures, run.account_id]); return runSchema.parse(this.db.get("SELECT * FROM mail_graph_runs WHERE account_id=?", [run.account_id])); }); }
    putMetadata(accountId: string, value: GraphMessage) {
      return this.db.transaction(() => {
        this.account(accountId);
        const parsed = graphMessageSchema.parse(value), locator = { provider: "graph", messageId: parsed.id } satisfies import("../model.js").ProviderMessageLocator;
        if (!this.db.get("SELECT 1 FROM mail_folders WHERE account_id=? AND id=?", [accountId, parsed.parentFolderId]))
            this.repository.putFolder(accountId, { id: parsed.parentFolderId, name: parsed.parentFolderId, kind: "folder" });
        const old = this.repository.readMessage(accountId, locator);
        // Graph parentFolderId is authoritative; a move keeps immutable identity and stored original.
        this.repository.ingestMessage(accountId, { locator, subject: parsed.subject, rfcMessageId: parsed.internetMessageId ?? old?.rfc_message_id ?? null, threadId: parsed.conversationId ?? null, memberships: [parsed.parentFolderId] });
        this.db.run("UPDATE mail_messages SET is_read=? WHERE account_id=? AND message_key=?", [parsed.isRead ? 1 : 0, accountId, providerMessageKey(locator)]);
        this.db.run("INSERT INTO mail_graph_messages(account_id,message_key,metadata_json) VALUES(?,?,?) ON CONFLICT(account_id,message_key) DO UPDATE SET metadata_json=excluded.metadata_json", [accountId, providerMessageKey(locator), JSON.stringify(parsed)]);
      });
    }
    attachment(accountId: string, key: string, raw: string, value: GraphAttachment, ref: string | null, error: GraphIssue | null) { this.account(accountId); graphAttachmentSchema.parse(value); this.db.run("INSERT INTO mail_graph_attachments(account_id,message_key,id,raw_ref_id,metadata_json,ref_id,error) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,message_key,id) DO UPDATE SET raw_ref_id=excluded.raw_ref_id,metadata_json=excluded.metadata_json,ref_id=excluded.ref_id,error=excluded.error", [accountId, key, value.id, raw, JSON.stringify(value), ref, error]); }
    issue(accountId: string, key: string, error: GraphIssue) { this.account(accountId); this.db.run("UPDATE mail_graph_messages SET error=?,parts_complete=0 WHERE account_id=? AND message_key=?", [error, accountId, key]); }
    progress(accountId: string, generation: string) {
        this.account(accountId);
        const totals = this.db.get(`SELECT count(*) AS enumerated,coalesce(sum(EXISTS(SELECT 1 FROM mail_content_manifests c JOIN mail_blob_publications b ON b.account_id=c.account_id AND b.ref_id=c.ref_id WHERE c.account_id=m.account_id AND c.message_key=m.message_key AND c.kind='raw' AND c.state='stored')),0) AS downloaded,
    coalesce(sum(m.parts_complete=1 AND m.raw_change_key=json_extract(m.metadata_json,'$.changeKey') AND m.error IS NULL AND EXISTS(SELECT 1 FROM mail_messages mm WHERE mm.account_id=m.account_id AND mm.message_key=m.message_key AND mm.attachments_enumerated=1) AND EXISTS(SELECT 1 FROM mail_mime_projections p JOIN mail_content_manifests r ON r.account_id=p.account_id AND r.message_key=p.message_key AND r.kind='raw' AND r.ref_id=p.raw_ref_id JOIN mail_content_manifests b ON b.account_id=p.account_id AND b.message_key=p.message_key AND b.kind='body' AND b.ref_id=p.body_ref_id JOIN mail_blob_publications pub ON pub.account_id=b.account_id AND pub.ref_id=b.ref_id WHERE p.account_id=m.account_id AND p.message_key=m.message_key AND p.state='complete'
    AND NOT EXISTS(SELECT 1 FROM mail_graph_attachments a LEFT JOIN mail_blob_publications ap ON ap.account_id=a.account_id AND ap.ref_id=a.ref_id WHERE a.account_id=m.account_id AND a.message_key=m.message_key AND (a.raw_ref_id!=p.raw_ref_id OR a.error IS NOT NULL OR ap.ref_id IS NULL))
    AND NOT EXISTS(SELECT 1 FROM mail_content_manifests c LEFT JOIN mail_content_refs cr ON cr.account_id=c.account_id AND cr.id=c.ref_id LEFT JOIN mail_blob_publications cp ON cp.account_id=c.account_id AND cp.ref_id=c.ref_id LEFT JOIN mail_blob_objects co ON co.account_id=cp.account_id AND co.id=cp.object_id WHERE c.account_id=m.account_id AND c.message_key=m.message_key AND (c.state!='stored' OR co.state IS NOT 'published' OR co.bytes IS NOT cr.bytes OR co.chunk_count IS NOT (cr.bytes/65536+CASE WHEN cr.bytes%65536>0 THEN 1 ELSE 0 END))))),0) AS projected,
    coalesce(sum(m.error='protected_or_inaccessible'),0) AS inaccessible,coalesce(sum(m.error IS NOT NULL),0) AS unavailable FROM mail_graph_messages m WHERE m.account_id=?`, [accountId]);
        const jobs = this.db.get("SELECT coalesce(sum(state IN ('queued','running','retry')),0) AS pending,coalesce(sum(state='failed'),0) AS failed,min(CASE WHEN state='running' THEN lease_until WHEN state='retry' THEN available_at END) AS retry_at FROM mail_sync_jobs WHERE account_id=? AND generation=?", [accountId, generation]);
        const folders = this.db.get("SELECT coalesce(sum(done=0),0) AS pending,coalesce(sum(error IS NOT NULL),0) AS unavailable FROM mail_graph_folder_queue WHERE account_id=?", [accountId]);
        const references = this.db.get("SELECT coalesce(sum(error='reference_attachment'),0) AS n,coalesce(sum(error='protected_or_inaccessible'),0) AS inaccessible FROM mail_graph_attachments WHERE account_id=?", [accountId]);
        return { enumerated: count.parse(totals?.enumerated), downloaded: count.parse(totals?.downloaded), projected: count.parse(totals?.projected), pending: count.parse(jobs?.pending), failed: count.parse(jobs?.failed), nextRetryAt: count.nullable().parse(jobs?.retry_at), folderPending: count.parse(folders?.pending), inaccessible: count.parse(totals?.inaccessible) + count.parse(folders?.unavailable) + count.parse(references?.inaccessible), unavailable: count.parse(totals?.unavailable), references: count.parse(references?.n) };
    }
}
