import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { providerMessageKey } from '../model.js';
import { MailContentStore } from './content-store.js';
import { EXTRACTION_VERSION, EXTRACTION_LIMITS, extractedSchema, type ExtractedText, type ExtractionErrorCode } from '../extraction/contract.js';
import { extractionRequestSchema, extractionReadSchema, extractionStatusSchema, extractionTextSchema, type MailExtractionRequest, type MailExtractionRead } from '../extraction-view.js';
const text = z.string(), integer = z.number().int().nonnegative();
export class MailExtractionStorageError extends Error {
    constructor(readonly code: 'not_found' | 'locked' | 'stale' | 'unavailable') { super('mail_extraction_' + code); }
}
export interface ExtractionLease {
    accountId: string;
    messageKey: string;
    partId: string;
    referenceId: string;
    token: string;
    credentialGeneration: string | null;
    filename: string;
    contentType: string;
    bytes: number;
}
/** All publication paths fence the exact current part, durable lease and credential generation. */
export class MailExtractionStore {
    constructor(private readonly db: MailDatabase, private readonly ownerId: string, private readonly now: () => number = Date.now) { }
    private account(accountId: string) { const row = this.db.get('SELECT a.provider,c.state,c.generation FROM mail_accounts a LEFT JOIN mail_account_access c ON c.account_id=a.id WHERE a.id=? AND a.owner_id=?', [accountId, this.ownerId]); if (!row)
        throw new MailExtractionStorageError('not_found'); if (row.provider === 'imap') {
        const imap = this.db.get('SELECT state,archive_locked,generation FROM mail_imap_credentials WHERE account_id=?', [accountId]);
        if (imap?.state === 'disconnected' || imap?.archive_locked === 1)
            throw new MailExtractionStorageError('locked');
        return typeof imap?.generation === 'string' ? imap.generation : null;
    } if (row.state === 'disconnected')
        throw new MailExtractionStorageError('locked'); return typeof row.generation === 'string' ? row.generation : null; }
    private manifest(accountId: string, request: MailExtractionRequest) { this.account(accountId); const parsed = extractionRequestSchema.parse(request); const row = this.db.get("SELECT m.state,p.ref_id,r.bytes FROM mail_content_manifests m LEFT JOIN mail_content_refs r ON r.account_id=m.account_id AND r.id=m.ref_id LEFT JOIN mail_blob_publications p ON p.account_id=m.account_id AND p.ref_id=m.ref_id WHERE m.account_id=? AND m.message_key=? AND m.kind='attachment' AND m.part_id=? AND m.ref_id IS ?", [accountId, providerMessageKey(parsed.locator), parsed.partId, parsed.referenceId]); if (!row)
        throw new MailExtractionStorageError('not_found'); return row; }
    status(accountId: string, request: MailExtractionRequest) { const manifest = this.manifest(accountId, request), row = this.db.get('SELECT * FROM mail_attachment_extractions WHERE account_id=? AND message_key=? AND part_id=? AND ref_id=? AND extractor=?', [accountId, providerMessageKey(request.locator), request.partId, request.referenceId, EXTRACTION_VERSION]); const downloaded = manifest.state === 'stored' && typeof manifest.ref_id === 'string'; return extractionStatusSchema.parse({ accountId, ...request, extractor: EXTRACTION_VERSION, downloaded, state: downloaded ? row?.state ?? 'queued' : 'pending_download', attempts: row?.attempts ?? 0, error: row?.error ?? null, sections: typeof row?.result_json === 'string' ? extractedSchema.parse(JSON.parse(row.result_json)).sections.length : 0 }); }
    read(accountId: string, supplied: MailExtractionRead) { const request = extractionReadSchema.parse(supplied), status = this.status(accountId, { locator: request.locator, partId: request.partId, referenceId: request.referenceId }); if (status.state !== 'complete')
        throw new MailExtractionStorageError('not_found'); const row = this.db.get('SELECT result_json FROM mail_attachment_extractions WHERE account_id=? AND message_key=? AND part_id=? AND ref_id=? AND extractor=?', [accountId, providerMessageKey(request.locator), request.partId, request.referenceId, EXTRACTION_VERSION]); const result = extractedSchema.parse(JSON.parse(text.parse(row?.result_json))), section = result.sections[request.section]; if (!section || request.offset > section.text.length)
        throw new MailExtractionStorageError('not_found'); const value = section.text.slice(request.offset, request.offset + request.limit), next = request.offset + value.length; return extractionTextSchema.parse({ status, section: request.section, offset: request.offset, source: section.source, method: section.method, text: value, nextOffset: next < section.text.length ? next : null, nextSection: next >= section.text.length && request.section + 1 < result.sections.length ? request.section + 1 : null }); }
    reset(accountId: string, request: MailExtractionRequest) { return this.db.transaction(() => { this.manifest(accountId, request); this.db.run("UPDATE mail_attachment_extractions SET state='queued',attempts=0,lease_token=NULL,lease_until=NULL,error=NULL,result_json=NULL WHERE account_id=? AND message_key=? AND part_id=? AND ref_id=? AND extractor=?", [accountId, providerMessageKey(request.locator), request.partId, request.referenceId, EXTRACTION_VERSION]); return this.status(accountId, request); }); }
    claim(afterAccount = ''): ExtractionLease | null {
        return this.db.transaction(() => {
            // Restart recovery is bounded per tick; exhausted crashed jobs become visible failures.
            const expired = this.db.all("SELECT account_id,message_key,part_id,ref_id FROM mail_attachment_extractions e WHERE state='running' AND lease_until<=? AND EXISTS(SELECT 1 FROM mail_accounts a WHERE a.id=e.account_id AND a.owner_id=?) LIMIT 10", [this.now(), this.ownerId]);
            for (const row of expired)
                this.db.run("UPDATE mail_attachment_extractions SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error=CASE WHEN attempts>=3 THEN 'runtime_failed' ELSE NULL END,lease_token=NULL,lease_until=NULL WHERE account_id=? AND message_key=? AND part_id=? AND ref_id=?", [text.parse(row.account_id), text.parse(row.message_key), text.parse(row.part_id), text.parse(row.ref_id)]);
            const select = (after: string) => this.db.get(`SELECT e.*,r.bytes,m.locator_json FROM mail_attachment_extractions e JOIN mail_accounts a ON a.id=e.account_id JOIN mail_messages m ON m.account_id=e.account_id AND m.message_key=e.message_key JOIN mail_content_manifests c ON c.account_id=e.account_id AND c.message_key=e.message_key AND c.kind='attachment' AND c.part_id=e.part_id AND c.ref_id=e.ref_id AND c.state='stored' JOIN mail_blob_publications p ON p.account_id=c.account_id AND p.ref_id=c.ref_id JOIN mail_content_refs r ON r.account_id=c.account_id AND r.id=c.ref_id
   WHERE a.owner_id=? AND a.id>? AND e.extractor=? AND e.state='queued' AND e.attempts<3
   AND NOT EXISTS(SELECT 1 FROM mail_account_access v WHERE v.account_id=a.id AND v.state='disconnected')
   AND NOT EXISTS(SELECT 1 FROM mail_imap_credentials v WHERE v.account_id=a.id AND (v.state='disconnected' OR v.archive_locked=1))
   AND (EXISTS(SELECT 1 FROM mail_mime_parts x JOIN mail_content_manifests raw ON raw.account_id=x.account_id AND raw.message_key=x.message_key AND raw.kind='raw' AND raw.ref_id=x.raw_ref_id WHERE x.account_id=e.account_id AND x.message_key=e.message_key AND x.part_id=e.part_id AND x.content_ref_id=e.ref_id)
   OR EXISTS(SELECT 1 FROM mail_graph_attachments x JOIN mail_content_manifests raw ON raw.account_id=x.account_id AND raw.message_key=x.message_key AND raw.kind='raw' AND raw.ref_id=x.raw_ref_id WHERE x.account_id=e.account_id AND x.message_key=e.message_key AND 'graph:'||x.id=e.part_id AND x.ref_id=e.ref_id))
   ORDER BY a.id,e.message_key,e.part_id LIMIT 1`, [this.ownerId, after, EXTRACTION_VERSION]);
            const row = select(afterAccount) ?? select('');
            if (!row)
                return null;
            const accountId = text.parse(row.account_id), messageKey = text.parse(row.message_key), partId = text.parse(row.part_id), referenceId = text.parse(row.ref_id), token = randomUUID();
            const mime = this.db.get('SELECT metadata_json FROM mail_mime_parts WHERE account_id=? AND message_key=? AND part_id=? AND content_ref_id=?', [accountId, messageKey, partId, referenceId]);
            const graph = mime ? null : this.db.get('SELECT metadata_json FROM mail_graph_attachments WHERE account_id=? AND message_key=? AND id=? AND ref_id=?', [accountId, messageKey, partId.slice(6), referenceId]);
            let metadata: {
                filename?: string | null;
                name?: string;
                contentType?: string | null;
            };
            try {
                metadata = z.object({ filename: z.string().nullable().optional(), name: z.string().optional(), contentType: z.string().nullable().optional() }).parse(JSON.parse(text.parse(mime?.metadata_json ?? graph?.metadata_json)));
            }
            catch {
                this.db.run("UPDATE mail_attachment_extractions SET state='failed',error='malformed' WHERE account_id=? AND message_key=? AND part_id=? AND ref_id=? AND extractor=?", [accountId, messageKey, partId, referenceId, EXTRACTION_VERSION]);
                return null;
            }
            this.db.run("UPDATE mail_attachment_extractions SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE account_id=? AND message_key=? AND part_id=? AND ref_id=? AND extractor=?", [token, this.now() + EXTRACTION_LIMITS.wallMs + 30000, accountId, messageKey, partId, referenceId, EXTRACTION_VERSION]);
            return { accountId, messageKey, partId, referenceId, token, credentialGeneration: this.account(accountId), filename: metadata.filename ?? metadata.name ?? '', contentType: metadata.contentType ?? 'application/octet-stream', bytes: integer.parse(row.bytes) };
        });
    }
    assertLease(lease: ExtractionLease) { if (this.account(lease.accountId) !== lease.credentialGeneration)
        throw new MailExtractionStorageError('stale'); if (!this.db.get(`SELECT 1 FROM mail_attachment_extractions e JOIN mail_content_manifests m ON m.account_id=e.account_id AND m.message_key=e.message_key AND m.part_id=e.part_id AND m.kind='attachment' AND m.state='stored' AND m.ref_id=e.ref_id WHERE e.account_id=? AND e.message_key=? AND e.part_id=? AND e.ref_id=? AND e.extractor=? AND e.state='running' AND e.lease_token=? AND e.lease_until>?`, [lease.accountId, lease.messageKey, lease.partId, lease.referenceId, EXTRACTION_VERSION, lease.token, this.now()]))
        throw new MailExtractionStorageError('stale'); }
    bytes(lease: ExtractionLease) { this.assertLease(lease); if (lease.bytes > EXTRACTION_LIMITS.inputBytes)
        throw new MailExtractionStorageError('unavailable'); return Buffer.concat([...new MailContentStore(this.db, this.ownerId).read(lease.accountId, lease.referenceId)]); }
    finish(lease: ExtractionLease, result: ExtractedText | ExtractionErrorCode) { this.db.transaction(() => { this.assertLease(lease); this.db.run('UPDATE mail_attachment_extractions SET state=?,result_json=?,error=?,lease_token=NULL,lease_until=NULL WHERE account_id=? AND message_key=? AND part_id=? AND ref_id=? AND extractor=?', [typeof result === 'string' ? 'failed' : 'complete', typeof result === 'string' ? null : JSON.stringify(extractedSchema.parse(result)), typeof result === 'string' ? result : null, lease.accountId, lease.messageKey, lease.partId, lease.referenceId, EXTRACTION_VERSION]); }); }
}
