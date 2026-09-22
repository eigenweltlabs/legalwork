import { assertMailSchema } from './consistency.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { MailRepository } from './repository.js';
import { ImapError, imapSettingsSchema, type ImapSettings } from '../providers/imap-config.js';
export const IMAP_SCHEMA_SQL = `
CREATE TABLE mail_imap_credentials(account_id TEXT PRIMARY KEY,generation TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN ('connected','disconnected')),archive_locked INTEGER NOT NULL CHECK(archive_locked IN (0,1)),settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),password TEXT,CHECK((state='connected' AND archive_locked=0 AND password IS NOT NULL) OR (state='disconnected' AND archive_locked=1 AND password IS NULL)),FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
CREATE TABLE mail_imap_messages(account_id TEXT NOT NULL,message_key TEXT NOT NULL,internal_date INTEGER,PRIMARY KEY(account_id,message_key),FOREIGN KEY(account_id,message_key) REFERENCES mail_messages(account_id,message_key));
CREATE TABLE mail_imap_runs(account_id TEXT PRIMARY KEY,generation TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL CHECK(state IN ('active','paused','complete','attention')),retry_at INTEGER,error TEXT,failures INTEGER NOT NULL DEFAULT 0,discovered INTEGER NOT NULL DEFAULT 0,capabilities_json TEXT NOT NULL DEFAULT '[]',FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
CREATE TABLE mail_imap_folders(account_id TEXT NOT NULL,path TEXT NOT NULL,delimiter TEXT,special_use TEXT,selectable INTEGER NOT NULL,selected INTEGER NOT NULL,uid_validity INTEGER,uid_next INTEGER,after_uid INTEGER NOT NULL DEFAULT 0,uid_span INTEGER NOT NULL DEFAULT 1000,done INTEGER NOT NULL DEFAULT 0,generation TEXT NOT NULL,PRIMARY KEY(account_id,path),FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
`;
export type ImapVersion = {
    generation: string;
    revision: number;
};
export class ImapCustody {
    private readonly repository: MailRepository;
    constructor(private readonly db: MailDatabase, private readonly ownerId: string) { try {
        assertMailSchema(db);
        if (db.get('SELECT sqlite3mc_version() AS engine')?.engine !== 'SQLite3 Multiple Ciphers 2.4.0' || Object.values(db.get('PRAGMA cipher') ?? {})[0] !== 'sqlcipher' || db.get('PRAGMA temp_store')?.temp_store !== 2)
            throw new ImapError('unavailable');
    }
    catch {
        throw new ImapError('unavailable');
    } this.repository = new MailRepository(db, ownerId); }
    account(id: string) { if (!this.db.get("SELECT id FROM mail_accounts WHERE id=? AND owner_id=? AND provider='imap'", [id, this.ownerId]))
        throw new ImapError('invalid_input'); }
    version(id: string): ImapVersion | null { this.account(id); const row = this.db.get('SELECT generation,revision FROM mail_imap_credentials WHERE account_id=?', [id]); return row ? z.object({ generation: z.string().uuid(), revision: z.number().int().positive() }).parse(row) : null; }
    read(id: string) { this.account(id); const row = z.object({ generation: z.string().uuid(), revision: z.number(), state: z.enum(['connected', 'disconnected']), settings_json: z.string(), password: z.string().nullable() }).parse(this.db.get('SELECT * FROM mail_imap_credentials WHERE account_id=?', [id])); if (row.state !== 'connected' || row.password === null)
        throw new ImapError('locked'); return { settings: imapSettingsSchema.parse(JSON.parse(row.settings_json)), password: row.password, version: { generation: row.generation, revision: row.revision } }; }
    assert(id: string, version: ImapVersion) { const current = this.read(id); if (current.version.generation !== version.generation || current.version.revision !== version.revision)
        throw new ImapError('stale_credentials'); }
    connect(settings: ImapSettings, password: string, reconnect: string | undefined, expected: ImapVersion | null): string {
        return this.db.transaction(() => {
            const id = 'imap:' + createHash('sha256').update(JSON.stringify([this.ownerId, settings.host, settings.port, settings.username])).digest('hex');
            if (reconnect && reconnect !== id)
                throw new ImapError('invalid_input');
            const existing = this.db.get('SELECT id FROM mail_accounts WHERE id=?', [id]);
            if (existing && !reconnect)
                throw new ImapError('reconnect_required');
            if (!existing && reconnect)
                throw new ImapError('invalid_input');
            if (existing) {
                const current = this.version(id);
                if (!current || !expected || current.generation !== expected.generation || current.revision !== expected.revision)
                    throw new ImapError('stale_credentials');
            }
            else
                this.repository.createAccount({ id, provider: 'imap', displayName: settings.username });
            this.db.run("INSERT INTO mail_imap_credentials(account_id,generation,revision,state,archive_locked,settings_json,password) VALUES(?,?,1,'connected',0,?,?) ON CONFLICT(account_id) DO UPDATE SET generation=excluded.generation,revision=revision+1,state='connected',archive_locked=0,settings_json=excluded.settings_json,password=excluded.password", [id, randomUUID(), JSON.stringify(settings), password]);
            return id;
        });
    }
    disconnect(id: string, expected: ImapVersion): ImapVersion { return this.db.transaction(() => { const current = this.version(id); if (!current || current.generation !== expected.generation || current.revision !== expected.revision)
        throw new ImapError('stale_credentials'); const generation = randomUUID(); this.db.run("UPDATE mail_imap_credentials SET state='disconnected',archive_locked=1,password=NULL,generation=?,revision=revision+1 WHERE account_id=?", [generation, id]); return { generation, revision: current.revision + 1 }; }); }
}
