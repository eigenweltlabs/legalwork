import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { MailCredentialRepository } from './credentials.js';
import { MailClassifierStore } from './classifier.js';
import { MailProjectAssociations } from './project-associations.js';
import { MailReadStore } from './read-store.js';
import { MAIL_LIVE_INBOX_SQL } from './snooze-sql.js';
import { classifyMailProject } from '../classifier.js';
import { MailClassifierError, mailClassifierDefinitionSchema } from '../classifier-view.js';
import { providerMessageKey, providerMessageLocatorSchema, type ProviderMessageLocator } from '../model.js';
import type { MailProjectReference } from '../project-association-view.js';
import { mailClassifierPlanSchema, mailClassifierActivitySchema, mailClassifierActivityInputSchema, mailClassifierReviewActionSchema, mailClassifierActionResultSchema, mailClassifierCommitSchema, mailClassifierOutcomeSchema, type MailClassifierPlan, type MailClassifierActivity } from '../classifier-incoming-view.js';
const rowSchema = z.object({ id: z.number().int().positive(), account_id: z.string(), message_key: z.string(), generation: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), config_generation: z.string().uuid(), config_revision: z.number().int().positive(), credential_generation: z.string(), observed_at: z.number().int().nonnegative(), available_at: z.number().int().nonnegative(), state: z.enum(['pending', 'review', 'assigned', 'dismissed', 'undone', 'skipped']), outcome: mailClassifierOutcomeSchema.nullable(), project_id: z.string().nullable(), project_binding: z.string().nullable() });
type Arrival = z.infer<typeof rowSchema>;
const captureConfigSchema = z.object({ generation: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), credential_generation: z.string().nullable() });
function version(row: Arrival) { return { generation: row.generation, revision: row.revision }; }
function reference(row: Arrival) { return row.project_id !== null && row.project_binding !== null ? { id: row.project_id, binding: row.project_binding } : null; }
/** Only fenced incremental provider commits call this before inserting a new identity. */
export function captureMailProjectArrival(db: MailDatabase, ownerId: string, accountId: string, locator: ProviderMessageLocator, now = Date.now()) {
    if (locator.provider === 'archive' || !db.get('SELECT 1 FROM mail_accounts WHERE id=? AND owner_id=? AND provider=?', [accountId, ownerId, locator.provider]))
        return;
    const row = db.get("SELECT * FROM mail_project_classifiers WHERE account_id=? AND json_extract(definition_json,'$.mode')='automatic'", [accountId]);
    if (!row)
        return;
    const captured = captureConfigSchema.safeParse(row);
    if (!captured.success)
        return;
    const snapshot = captured.data;
    let definition: unknown;
    try {
        definition = JSON.parse(String(row.definition_json));
    }
    catch {
        return;
    }
    const parsed = mailClassifierDefinitionSchema.safeParse(definition);
    if (!parsed.success || !parsed.data.rules.some(rule => rule.enabled))
        return;
    const key = providerMessageKey(locator);
    if (db.get('SELECT 1 FROM mail_messages WHERE account_id=? AND message_key=?', [accountId, key]) || db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1', [accountId]))
        return;
    const credential = new MailCredentialRepository(db, ownerId).status(accountId);
    if (credential.state !== 'connected' || credential.archiveLocked || credential.version.generation !== snapshot.credential_generation)
        return;
    db.run('INSERT OR IGNORE INTO mail_project_arrivals(account_id,message_key,generation,config_generation,config_revision,credential_generation,observed_at,available_at) VALUES(?,?,?,?,?,?,?,?)', [accountId, key, randomUUID(), snapshot.generation, snapshot.revision, credential.version.generation, now, now]);
}
export class MailClassifierArrivals {
    constructor(private db: MailDatabase, private ownerId: string, private now: () => number = Date.now, private canAutomate: () => boolean = () => true) { }
    private configs() { return new MailClassifierStore(this.db, this.ownerId, this.now, this.canAutomate); }
    private projects() { return new MailProjectAssociations(this.db, this.ownerId, this.now); }
    private account(accountId: string) { this.configs().read(accountId); }
    private row(accountId: string, id: number) { this.account(accountId); const row = this.db.get('SELECT * FROM mail_project_arrivals WHERE account_id=? AND id=?', [accountId, id]); if (!row)
        throw new MailClassifierError('not_found'); return rowSchema.parse(row); }
    private finish(row: Arrival, state: Arrival['state'], outcome: z.infer<typeof mailClassifierOutcomeSchema>, project: MailProjectReference | null = null) {
        if (row.revision >= Number.MAX_SAFE_INTEGER)
            throw new MailClassifierError('conflict');
        const result = this.db.run('UPDATE mail_project_arrivals SET state=?,outcome=?,project_id=?,project_binding=?,revision=revision+1 WHERE id=? AND generation=? AND revision=?', [state, outcome, project?.id ?? null, project?.binding ?? null, row.id, row.generation, row.revision]);
        if (result.changes !== 1)
            throw new MailClassifierError('conflict');
    }
    private defer(row: Arrival) { this.db.run("UPDATE mail_project_arrivals SET available_at=? WHERE id=? AND generation=? AND revision=? AND state='pending'", [this.now() + 30000, row.id, row.generation, row.revision]); }
    private locator(row: Arrival) { const message = this.db.get('SELECT locator_json FROM mail_messages WHERE account_id=? AND message_key=?', [row.account_id, row.message_key]); return typeof message?.locator_json === 'string' ? providerMessageLocatorSchema.parse(JSON.parse(message.locator_json)) : null; }
    private prepare(row: Arrival): MailClassifierPlan | null {
        if (row.state !== 'pending')
            return null;
        if (this.now() - row.observed_at > 7 * 86400000) {
            this.finish(row, 'review', 'expired');
            return null;
        }
        const config = this.configs().read(row.account_id);
        if (config.definition.mode !== 'automatic' || config.version?.generation !== row.config_generation || config.version.revision !== row.config_revision) {
            this.finish(row, 'skipped', 'config_changed');
            return null;
        }
        const credential = new MailCredentialRepository(this.db, this.ownerId).status(row.account_id);
        if (credential.state !== 'connected' || credential.archiveLocked || credential.version.generation !== row.credential_generation || config.automaticStatus === 'connection_changed' || config.automaticStatus === 'unavailable') {
            this.finish(row, 'skipped', 'connection_changed');
            return null;
        }
        if (!this.canAutomate() || config.automaticStatus !== 'ready') {
            this.defer(row);
            return null;
        }
        const locator = this.locator(row);
        if (!locator) {
            this.defer(row);
            return null;
        }
        if (this.db.get('SELECT 1 FROM mail_tombstones WHERE account_id=? AND message_key=?', [row.account_id, row.message_key])) {
            this.finish(row, 'skipped', 'removed');
            return null;
        }
        if (!this.db.get(`SELECT 1 FROM mail_messages m WHERE m.account_id=? AND m.message_key=? AND ${MAIL_LIVE_INBOX_SQL}`, [row.account_id, row.message_key])) {
            this.finish(row, 'skipped', 'not_inbox');
            return null;
        }
        if (this.projects().read(row.account_id, locator).version !== null) {
            this.finish(row, 'skipped', 'manual');
            return null;
        }
        let message: ReturnType<MailReadStore['read']>;
        try {
            message = new MailReadStore(this.db, this.ownerId, this.now).read(row.account_id, locator);
        }
        catch {
            this.finish(row, 'review', 'unavailable');
            return null;
        }
        if (message.removed) {
            this.finish(row, 'skipped', 'removed');
            return null;
        }
        const metadata = message.metadata, received = message.receivedAt;
        if (!metadata || received == null) {
            if (message.contentState === 'complete')
                this.finish(row, 'review', 'unavailable');
            else
                this.defer(row);
            return null;
        }
        const activated = this.db.get('SELECT activated_at FROM mail_project_classifiers WHERE account_id=?', [row.account_id])?.activated_at;
        if (typeof activated !== 'number' || received < activated || received > this.now()) {
            this.finish(row, 'skipped', 'historical');
            return null;
        }
        const evaluated = classifyMailProject(config.definition, { from: metadata.from, subject: metadata.subject });
        if (evaluated.status !== 'suggested') {
            this.finish(row, evaluated.status === 'ambiguous' || evaluated.status === 'unavailable' ? 'review' : 'skipped', evaluated.status === 'ambiguous' ? 'ambiguous' : evaluated.status === 'excluded' ? 'excluded' : evaluated.status === 'unavailable' ? 'unavailable' : 'unmatched');
            return null;
        }
        const candidate = evaluated.candidates[0], threshold = config.definition.automaticThreshold ?? 'reference_sender';
        const qualifies = threshold === 'any_rule' || candidate.rules.some(rule => rule.reasons.includes('reference') && (threshold === 'reference' || rule.reasons.includes('sender') || rule.reasons.includes('domain')));
        if (!qualifies) {
            this.finish(row, 'review', 'below_threshold', candidate.project);
            return null;
        }
        const fingerprint = createHash('sha256').update(JSON.stringify([row.account_id, locator, config.version, message.rawReferenceId, received, metadata.from, metadata.subject])).digest('hex');
        return mailClassifierPlanSchema.parse({ id: row.id, version: version(row), accountId: row.account_id, locator, configVersion: config.version, fingerprint, project: candidate.project, threshold, rules: candidate.rules });
    }
    pending() {
        const rows = this.db.all("SELECT r.* FROM mail_project_arrivals r JOIN mail_accounts a ON a.id=r.account_id WHERE a.owner_id=? AND r.state='pending' AND r.available_at<=? ORDER BY r.available_at,r.id LIMIT 25", [this.ownerId, this.now()]);
        const items: MailClassifierPlan[] = [];
        for (const supplied of rows) {
            const row = rowSchema.parse(supplied), plan = this.db.transaction(() => this.prepare(row));
            if (!plan)
                continue;
            if (Buffer.byteLength(JSON.stringify({ classifierPending: { items: [...items, plan] } })) > 60000) {
                if (!items.length) {
                    this.db.transaction(() => this.finish(row, 'review', 'unavailable'));
                    continue;
                }
                break;
            }
            items.push(plan);
            if (items.length === 5)
                break;
        }
        return { items };
    }
    commit(supplied: MailClassifierPlan, project: MailProjectReference | null) {
        const plan = mailClassifierPlanSchema.parse(supplied);
        const response = (outcome: z.infer<typeof mailClassifierCommitSchema>['outcome']) => mailClassifierCommitSchema.parse({ accountId: plan.accountId, id: plan.id, outcome });
        return this.db.transaction(() => {
            const row = this.row(plan.accountId, plan.id);
            if (row.generation !== plan.version.generation || row.revision !== plan.version.revision || row.state !== 'pending')
                throw new MailClassifierError('conflict');
            const current = this.prepare(row);
            if (!current) {
                const state = this.row(plan.accountId, plan.id).state;
                return response(state === 'review' ? 'review' : state === 'pending' ? 'pending' : 'skipped');
            }
            if (current.fingerprint !== plan.fingerprint || JSON.stringify(current) !== JSON.stringify(plan)) {
                this.defer(row);
                return response('pending');
            }
            if (project === null) {
                this.finish(row, 'review', 'unavailable', current.project);
                return response('review');
            }
            if (project.id !== current.project.id || project.binding !== current.project.binding)
                throw new MailClassifierError('conflict');
            this.projects().setAutomatic(plan.accountId, { locator: plan.locator, expected: null, project: current.project }, { arrivalId: row.id, configVersion: current.configVersion, threshold: current.threshold, rules: current.rules });
            this.finish(row, 'assigned', 'assigned', current.project);
            return response('assigned');
        });
    }
    activity(accountId: string, supplied: z.infer<typeof mailClassifierActivityInputSchema>) {
        this.account(accountId);
        const input = mailClassifierActivityInputSchema.parse(supplied);
        const rows = this.db.all(`SELECT r.* FROM mail_project_arrivals r JOIN mail_messages m ON m.account_id=r.account_id AND m.message_key=r.message_key LEFT JOIN mail_project_associations p ON p.account_id=r.account_id AND p.message_key=r.message_key WHERE r.account_id=? AND (? IS NULL OR r.id<?) AND (?='all' OR ?='review' AND r.state='review' AND p.generation IS NULL OR ?='assigned' AND r.state IN ('assigned','undone')) ORDER BY r.id DESC LIMIT 21`, [accountId, input.beforeId ?? null, input.beforeId ?? null, input.filter, input.filter, input.filter]);
        const selected = rows.slice(0, 20).map(row => rowSchema.parse(row)), items: MailClassifierActivity['items'] = [];
        for (const row of selected) {
            const locator = this.locator(row);
            if (!locator)
                continue;
            try {
                const message = new MailReadStore(this.db, this.ownerId, this.now).read(accountId, locator);
                if (message.removed)
                    continue;
                const assignment = this.projects().read(accountId, locator), canUndo = row.state === 'assigned' && assignment.source === 'automatic' && assignment.evidence?.arrivalId === row.id, canDismiss = row.state === 'review' && assignment.version === null;
                const outcome = row.state === 'review' && assignment.version !== null ? 'manual' : row.state === 'assigned' && !canUndo ? (assignment.project ? 'corrected' : 'cleared') : row.outcome ?? 'pending';
                items.push({ id: row.id, version: version(row), locator, subject: message.subject.slice(0, 200), at: row.observed_at, outcome, project: reference(row), assignmentVersion: assignment.version, canUndo, canDismiss });
            }
            catch { /* Removed or unreadable sources cannot leak through the review list. */ }
        }
        const page = mailClassifierActivitySchema.parse({ accountId, items, nextCursor: rows.length > 20 ? selected[selected.length - 1].id : null });
        while (page.items.length && Buffer.byteLength(JSON.stringify({ classifierActivity: page })) > 60000) {
            page.items.pop();
            page.nextCursor = page.items.at(-1)?.id ?? null;
            if (!page.items.length)
                throw new MailClassifierError('unavailable');
        }
        return page;
    }
    action(accountId: string, supplied: z.infer<typeof mailClassifierReviewActionSchema>, action: 'dismiss' | 'undo') {
        const input = mailClassifierReviewActionSchema.parse(supplied);
        return this.db.transaction(() => {
            const row = this.row(accountId, input.id), locator = this.locator(row);
            if (!locator)
                throw new MailClassifierError('not_found');
            if (row.generation !== input.expected.generation || row.revision !== input.expected.revision)
                throw new MailClassifierError('conflict');
            const current = this.projects().read(accountId, locator);
            if (JSON.stringify(current.version) !== JSON.stringify(input.assignmentVersion))
                throw new MailClassifierError('conflict');
            if (action === 'undo') {
                if (row.state !== 'assigned' || current.source !== 'automatic' || current.evidence?.arrivalId !== row.id)
                    throw new MailClassifierError('conflict');
                this.projects().set(accountId, { locator, expected: current.version, project: null });
            }
            else {
                if (row.state !== 'review' || current.version !== null)
                    throw new MailClassifierError('conflict');
                this.projects().dismissUnassigned(accountId, locator);
            }
            const outcome = action === 'undo' ? 'undone' : 'dismissed';
            this.finish(row, outcome, outcome, reference(row));
            return mailClassifierActionResultSchema.parse({ accountId, id: row.id, version: { generation: row.generation, revision: row.revision + 1 }, outcome });
        });
    }
}
