import { setTimeout as wait } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { qualificationInputSchema, qualificationTransportCodeSchema, type QualificationInput, type QualificationReport } from '../qualification-view.js';
import type { MailDatabase } from '../storage/database-interface.js';
import { MailCredentialRepository } from '../storage/credentials.js';
import { MailReadStore } from '../storage/read-store.js';
import type { MailAccessCoordinator } from '../providers/access-coordinator.js';
import { GmailReadTransport, GmailTransportError } from '../providers/gmail.js';
import { MimeProjectionStore } from '../storage/mime-projection-store.js';
import { projectMime, MimeProjectionError } from '../mime/project.js';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const locator = (messageId: string) => ({
    provider: 'gmail',
    messageId
} satisfies import('../model.js').ProviderMessageLocator);
const rowSchema = z.object({
    message_key: z.string(),
    locator_json: z.string(),
    received_at: z.number().nullable(),
    raw: z.string().nullable(),
    body: z.string().nullable(),
    attachments: z.number(),
    enumerated: z.number(),
    projection_state: z.string().nullable()
});
/** Explicit, bounded, memory-only read diagnostic. Never joins the sync/action journal. */
export class MailQualification {
    private job: {
        accountId: string;
        abort: AbortController;
        report: QualificationReport;
        done: Promise<void>;
    } | undefined;
    constructor(private options: {
        database: MailDatabase;
        ownerId: string;
        access: MailAccessCoordinator;
        transport?: (accountId: string, signal: AbortSignal) => Promise<GmailReadTransport>;
        timeoutMs?: number;
    }) {
    }
    execute(supplied: QualificationInput): QualificationReport {
        const input = qualificationInputSchema.parse(supplied);
        if (input.action !== 'start') {
            if (this.job?.report.id !== input.id)
                throw Error('qualification_unavailable');
            if (input.action === 'cancel')
                this.job.abort.abort();
            return structuredClone(this.job.report);
        }
        if (this.job?.report.state === 'running')
            throw Error('qualification_busy');
        const provider = this.options.database.get('SELECT provider FROM mail_accounts WHERE owner_id=? AND id=?', [this.options.ownerId, input.accountId])?.provider;
        if (provider !== 'gmail')
            throw Error('qualification_unsupported');
        const credentials = new MailCredentialRepository(this.options.database, this.options.ownerId), status = credentials.status(input.accountId);
        if (status.state !== 'connected' || status.archiveLocked)
            throw Error('qualification_unavailable');
        const report: QualificationReport = {
            id: randomUUID(),
            provider: 'gmail',
            startedAt: Date.now(),
            finishedAt: null,
            state: 'running',
            comparison: 'pending',
            phase: 'enumeration',
            maxMessages: input.maxMessages,
            sampleLimit: input.samples,
            scope: 'all_messages_including_spam_trash',
            providerMessages: 0,
            localMessages: 0,
            missingLocal: 0,
            extraLocal: 0,
            duplicateProviderIds: 0,
            providerLabels: 0,
            localLabels: 0,
            missingLabels: 0,
            extraLabels: 0,
            membershipsChecked: 0,
            metadataRetries: 0,
            membershipMismatches: 0,
            rawSamples: 0,
            rawMismatches: 0,
            attachmentSamples: 0,
            attachmentMismatches: 0,
            bodySamples: 0,
            bodyMismatches: 0,
            incompleteSamples: 0,
            skippedOversizeSamples: 0,
            downloadedSampleBytes: 0,
            providerStable: null,
            localStable: null,
            error: null,
            transportCode: null,
            retryAfterMs: null,
            failedPhase: null
        };
        const abort = new AbortController(), job = {
            accountId: input.accountId,
            abort,
            report,
            done: Promise.resolve()
        };
        this.job = job;
        const timer = setTimeout(() => abort.abort('deadline'), this.options.timeoutMs ?? 180000);
        job.done = this.run(input.accountId, report, abort.signal, status.version.generation).catch(error => {
            if (report.phase !== 'finished') report.failedPhase = report.phase;
            if (error instanceof GmailTransportError) {
                const code = qualificationTransportCodeSchema.safeParse(error.code);
                report.transportCode = code.success ? code.data : null;
                const retryAfter = error.retryAfterMs;
                report.retryAfterMs = typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter >= 0
                    ? retryAfter : null;
            }
            if (abort.signal.aborted) {
                const deadline = abort.signal.reason === 'deadline';
                report.state = deadline ? 'limited' : 'cancelled';
                report.error = deadline ? 'limit' : 'cancelled';
            } else {
                report.state = error instanceof RangeError ? 'limited' : 'failed';
                report.error = error instanceof RangeError ? 'limit' : 'provider_failed';
            }
        }).finally(() => {
            clearTimeout(timer);
            if (report.state !== 'complete')
                report.comparison = 'inconclusive';
            report.phase = 'finished';
            report.finishedAt = Date.now();
        });
        return structuredClone(report);
    }
    cancel(accountId?: string) {
        if (!accountId || this.job?.accountId === accountId)
            this.job?.abort.abort();
    }
    async close() {
        this.cancel();
        await this.job?.done;
    }
    private snapshot(accountId: string, max: number) {
        const db = this.options.database;
        const rows = db.all(`SELECT m.message_key,m.locator_json,gm.internal_date AS received_at,m.attachments_enumerated AS enumerated,
   (SELECT p.state FROM mail_mime_projections p JOIN mail_content_manifests c ON c.account_id=p.account_id AND c.message_key=p.message_key AND c.ref_id=p.raw_ref_id WHERE p.account_id=m.account_id AND p.message_key=m.message_key AND c.kind='raw') AS projection_state,
   (SELECT ref_id FROM mail_content_manifests c WHERE c.account_id=m.account_id AND c.message_key=m.message_key AND c.kind='raw' AND c.state='stored') AS raw,
   (SELECT ref_id FROM mail_content_manifests c WHERE c.account_id=m.account_id AND c.message_key=m.message_key AND c.kind='body' AND c.state='stored') AS body,
   (SELECT count(*) FROM mail_content_manifests c WHERE c.account_id=m.account_id AND c.message_key=m.message_key AND c.kind='attachment' AND c.state='stored') AS attachments
   FROM mail_messages m LEFT JOIN mail_gmail_metadata gm ON gm.account_id=m.account_id AND gm.message_key=m.message_key WHERE m.account_id=? AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.account_id=m.account_id AND t.message_key=m.message_key) ORDER BY gm.internal_date,m.message_key LIMIT ?`, [accountId, max + 1]).map(row => rowSchema.parse(row));
        if (rows.length > max)
            throw new RangeError('bounded');
        const members = new Map<string, string[]>();
        let membershipRows = 0;
        for (const row of db.all('SELECT message_key,folder_id FROM mail_memberships WHERE account_id=? ORDER BY message_key,folder_id LIMIT 10001', [accountId])) {
            if (++membershipRows > 10000)
                throw new RangeError('bounded');
            const value = z.object({
                message_key: z.string(),
                folder_id: z.string()
            }).parse(row);
            const list = members.get(value.message_key) ?? [];
            list.push(value.folder_id);
            members.set(value.message_key, list);
            if (list.length > 10000)
                throw new RangeError('bounded');
        }
        const labels = db.all('SELECT id FROM mail_folders WHERE account_id=? ORDER BY id LIMIT 10001', [accountId]).map(row => z.string().parse(row.id));
        const manifests = db.all('SELECT message_key,kind,part_id,ref_id,state FROM mail_content_manifests WHERE account_id=? ORDER BY message_key,kind,part_id LIMIT 50001', [accountId]);
        if (labels.length > 10000 || manifests.length > 50000)
            throw new RangeError('bounded');
        return {
            rows,
            members,
            labels,
            fingerprint: hash(JSON.stringify([rows, [...members], labels, manifests]))
        };
    }
    private async run(accountId: string, report: QualificationReport, signal: AbortSignal, generation: string) {
        const transports: GmailReadTransport[] = [];
        try {
            const db = this.options.database, credentials = new MailCredentialRepository(db, this.options.ownerId), reads = new MailReadStore(db, this.options.ownerId);
            const fence = () => {
                signal.throwIfAborted();
                const status = credentials.status(accountId);
                if (status.state !== 'connected' || status.archiveLocked || status.version.generation !== generation)
                    throw Error('unavailable');
            };
            const transport = async () => {
                fence();
                let result: GmailReadTransport;
                if (this.options.transport)
                    result = await this.options.transport(accountId, signal);
                else {
                    const granted = await this.options.access.acquire(accountId);
                    fence();
                    result = new GmailReadTransport({
                        accessToken: granted.accessToken,
                        maxRawBytes: 8 * 1024 * 1024
                    });
                }
                transports.push(result);
                return result;
            };
            const local = this.snapshot(accountId, report.maxMessages);
            report.localMessages = local.rows.length;
            report.localLabels = local.labels.length;
            const before = await (await transport()).getProfile({
                signal
            }), labels = await (await transport()).listLabels({
                signal
            });
            report.providerLabels = labels.labels.length;
            const providerLabels = new Set(labels.labels.map(value => value.id));
            report.missingLabels = [...providerLabels].filter(id => !local.labels.includes(id)).length;
            report.extraLabels = local.labels.filter(id => !providerLabels.has(id)).length;
            const ids = new Set<string>(), tokens = new Set<string>();
            let pageToken: string | undefined;
            for (let page = 0;; page++) {
                if (page >= 20)
                    throw new RangeError('bounded');
                const result = await (await transport()).listMessages({
                    pageToken,
                    pageSize: 500,
                    signal
                });
                for (const item of result.messages) {
                    if (ids.has(item.id))
                        report.duplicateProviderIds++;
                    ids.add(item.id);
                    if (ids.size > report.maxMessages)
                        throw new RangeError('bounded');
                }
                report.providerMessages = ids.size;
                if (!result.nextPageToken)
                    break;
                if (tokens.has(result.nextPageToken))
                    throw new RangeError('bounded');
                tokens.add(result.nextPageToken);
                pageToken = result.nextPageToken;
            }
            const localIds = new Map(local.rows.map(row => [z.object({
                    provider: z.literal('gmail'),
                    messageId: z.string()
                }).parse(JSON.parse(row.locator_json)).messageId, row]));
            report.missingLocal = [...ids].filter(id => !localIds.has(id)).length;
            report.extraLocal = [...localIds.keys()].filter(id => !ids.has(id)).length;
            report.phase = 'memberships';
            // The live run established Gmail rate limiting. Pace metadata starts;
            // retry only that confirmed read failure, never a raw MIME sink.
            let nextMetadataAt = 0;
            const deadline = report.startedAt + (this.options.timeoutMs ?? 180000);
            for (const id of ids) {
                for (let attempt = 0;; attempt++) {
                    const pace = Math.max(0, nextMetadataAt - Date.now());
                    if (pace) await wait(pace, undefined, { signal });
                    fence();
                    const reader = await transport();
                    nextMetadataAt = Date.now() + 150;
                    try {
                        const metadata = await reader.getMetadata(id, { signal });
                        fence();
                        report.membershipsChecked++;
                        const row = localIds.get(id);
                        const members = row ? local.members.get(row.message_key) ?? [] : [];
                        if (JSON.stringify([...metadata.labelIds].sort()) !== JSON.stringify(members)) {
                            report.membershipMismatches++;
                        }
                        break;
                    } catch (error) {
                        if (!(error instanceof GmailTransportError) || error.code !== 'rate_limited'
                            || attempt >= 3 || report.metadataRetries >= 8) throw error;
                        await reader.settled();
                        fence();
                        const backoff = Math.max(1000 * 2 ** attempt, error.retryAfterMs ?? 0);
                        if (backoff >= deadline - Date.now()) {
                            // Do not shorten Retry-After to fit the diagnostic deadline.
                            report.transportCode = error.code;
                            report.retryAfterMs = error.retryAfterMs;
                            throw new RangeError('bounded');
                        }
                        await wait(backoff, undefined, { signal });
                        fence();
                        report.metadataRetries++;
                    }
                }
            }
            report.phase = 'samples';
            // Oldest stored originals plus attachment-bearing messages; never requires opening them in Mail.
            const candidates = [...local.rows.filter(row => row.attachments > 0), ...local.rows];
            const selected = new Set<string>();
            for (const row of candidates) {
                if (selected.size >= report.sampleLimit)
                    break;
                const id = z.object({
                    messageId: z.string()
                }).parse(JSON.parse(row.locator_json)).messageId;
                if (!ids.has(id) || selected.has(id))
                    continue;
                selected.add(id);
                fence();
                const chunks: Uint8Array[] = [];
                let size = 0, byteLimit = false;
                try {
                    await (await transport()).consumeRaw(id, async (chunk) => {
                        fence();
                        size += chunk.length;
                        if (report.downloadedSampleBytes + size > 64 * 1024 * 1024) {
                            byteLimit = true;
                            throw new RangeError('bounded');
                        }
                        chunks.push(chunk);
                    }, {
                        signal
                    });
                }
                catch (error) {
                    if (byteLimit)
                        throw new RangeError('bounded');
                    if (error instanceof GmailTransportError && ['raw_too_large', 'response_too_large'].includes(error.code)) {
                        report.skippedOversizeSamples++;
                        continue;
                    }
                    throw error;
                }
                const raw = Buffer.concat(chunks), rawHash = hash(raw);
                report.downloadedSampleBytes += raw.length;
                report.rawSamples++;
                if (row.raw !== `sha256:${rawHash}`)
                    report.rawMismatches++;
                const source = locator(id);
                const readParts = () => {
                    const resultParts: ReturnType<MailReadStore['parts']>['items'] = [];
                    let after: string | undefined;
                    for (let page = 0; page < 20; page++) {
                        const result = reads.parts(accountId, source, {
                            limit: 100,
                            after
                        });
                        resultParts.push(...result.items);
                        if (!result.nextCursor)
                            return resultParts;
                        if (page === 19)
                            throw new RangeError('bounded');
                        after = result.nextCursor;
                    }
                    return resultParts;
                };
                const parts = readParts();
                const storedBytes = (part: typeof parts[number], limit: number) => {
                    if (!part.bytesAvailable || !part.referenceId || part.bytes === null || part.bytes > limit)
                        throw Error('unavailable');
                    const chunks: Buffer[] = [];
                    let read = 0;
                    do {
                        fence();
                        const chunk = reads.chunk(accountId, source, {
                            kind: part.kind,
                            partId: part.partId,
                            referenceId: part.referenceId,
                            offset: read,
                            limit: 24576
                        });
                        const bytes = Buffer.from(chunk.data, 'base64');
                        chunks.push(bytes);
                        read += bytes.length;
                        if (chunk.nextOffset === null)
                            break;
                        if (!bytes.length || chunk.nextOffset !== read)
                            throw Error('invalid');
                    } while (read < part.bytes);
                    if (read !== part.bytes)
                        throw Error('invalid');
                    return Buffer.concat(chunks);
                };
                const storedRaw = parts.find(part => part.kind === 'raw');
                if (storedRaw && row.raw === `sha256:${rawHash}` && hash(storedBytes(storedRaw, 8 * 1024 * 1024)) !== rawHash)
                    report.rawMismatches++;
                const storedProjection = new MimeProjectionStore(db, this.options.ownerId).read(accountId, source);
                let incomplete = reads.read(accountId, source).contentState !== 'complete'
                    || storedProjection?.state !== 'complete'
                    || !row.raw || !row.body || parts.some(part => !part.bytesAvailable);
                let projected: Awaited<ReturnType<typeof projectMime>>;
                try {
                    projected = await projectMime({
                        source: [raw],
                        originalSha256: rawHash,
                        signal,
                        limits: {
                            maxInputBytes: 8 * 1024 * 1024
                        },
                        onAttachment: async (_part, source) => {
                            for await (const _chunk of source)
                                fence();
                        }
                    });
                }
                catch (error) {
                    fence();
                    if (!(error instanceof MimeProjectionError))
                        throw error;
                    report.incompleteSamples++;
                    continue;
                }
                // The parser rejects unsupported, malformed and limited projections;
                // successful returns attest the supported projection, without warnings.
                incomplete ||= projected.validation !== 'supported-projection';
                fence();
                for (const part of projected.attachments) {
                    report.attachmentSamples++;
                    const stored = parts.find(value => value.kind === 'attachment' && value.partId === part.partId);
                    if (!stored?.bytesAvailable || stored.sha256 !== part.sha256 || stored.bytes !== part.bytes || hash(storedBytes(stored, 8 * 1024 * 1024)) !== part.sha256)
                        report.attachmentMismatches++;
                }
                const storedAttachments = parts.filter(value => value.kind === 'attachment');
                report.attachmentMismatches += storedAttachments.filter(value => !projected.attachments.some(part => part.partId === value.partId)).length;
                const body = parts.find(value => value.kind === 'body' && value.bytesAvailable && value.referenceId);
                if (body?.referenceId && body.bytes !== null && body.bytes <= 4 * 1024 * 1024) {
                    const parsed = z.object({
                        bodies: z.array(z.object({
                            partId: z.string(),
                            contentType: z.string(),
                            text: z.string()
                        }))
                    }).parse(JSON.parse(storedBytes(body, 4 * 1024 * 1024).toString('utf8')));
                    report.bodySamples++;
                    const texts = (values: typeof parsed.bodies) => values.map(({ partId, contentType, text }) => ({
                        partId,
                        contentType,
                        text
                    }));
                    if (hash(JSON.stringify(texts(parsed.bodies))) !== hash(JSON.stringify(texts(projected.bodies))))
                        report.bodyMismatches++;
                }
                else
                    incomplete = true;
                if (incomplete)
                    report.incompleteSamples++;
                if (JSON.stringify(readParts()) !== JSON.stringify(parts))
                    throw Error('changed');
            }
            fence();
            const final = await (await transport()).getProfile({
                signal
            });
            fence();
            report.providerStable = before.historyId === final.historyId;
            report.localStable = local.fingerprint === this.snapshot(accountId, report.maxMessages).fingerprint;
            report.state = report.providerStable && report.localStable && !report.duplicateProviderIds ? 'complete' : 'inconclusive';
            if (report.state === 'inconclusive')
                report.error = 'changed';
            const mismatches = report.missingLocal + report.extraLocal
                + report.missingLabels + report.extraLabels + report.membershipMismatches
                + report.rawMismatches + report.bodyMismatches + report.attachmentMismatches;
            if (report.state !== 'complete' || report.incompleteSamples || report.skippedOversizeSamples) {
                report.comparison = 'inconclusive';
            } else {
                report.comparison = mismatches ? 'mismatch' : 'match';
            }
        }
        finally {
            await Promise.allSettled(transports.map(transport => transport.settled()));
        }
    }
}
