/** Synthetic evaluation only. No production imports, credentials or default network transport. */
import { createHash } from 'node:crypto';

type Binding = string | number | Uint8Array | null;
interface Sqlite {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...values: Binding[]): unknown;
    get(...values: Binding[]): unknown;
    all(...values: Binding[]): unknown[];
  };
  close(): void;
}
export type Transport = (request: Request) => Promise<Response>;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
function values(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected list');
  return value;
}
export const origin = 'https://graph.microsoft.com';
export const initial = `${origin}/v1.0/me/mailFolders/inbox/messages/delta`;
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function openSpike(path: string) {
  let db: Sqlite;
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite');
    db = new Database(path, { create: true });
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path);
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS checkpoints(scope TEXT PRIMARY KEY, url TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(scope TEXT, id TEXT, subject TEXT, body TEXT, mime BLOB, hash TEXT,
      PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS attachments(scope TEXT, message TEXT, id TEXT, name TEXT, bytes BLOB, hash TEXT,
      PRIMARY KEY(scope,message,id));
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(scope UNINDEXED,id UNINDEXED,subject,body);`);
  const checkpoint = (scope: string) => {
    const row = db.prepare('SELECT url FROM checkpoints WHERE scope=?').get(scope);
    return row ? string(record(row).url) : initial;
  };
  const request = async (transport: Transport, url: string) => {
    const parsed = new URL(url);
    if (parsed.origin !== origin || parsed.username || parsed.password) throw new Error('Untrusted Graph URL');
    const response = await transport(new Request(url, { headers: { Prefer: 'IdType="ImmutableId"' } }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  };
  return {
    close: () => db.close(), checkpoint,
    search: (scope: string, query: string) => db.prepare(
      'SELECT id,subject FROM search WHERE search MATCH ? AND scope=? ORDER BY rank,id'
    ).all(query, scope),
    read: (scope: string, id: string) => db.prepare('SELECT * FROM messages WHERE scope=? AND id=?').get(scope,id),
    attachments: (scope: string, id: string) => db.prepare('SELECT * FROM attachments WHERE scope=? AND message=? ORDER BY id').all(scope,id),
    cipherVersion: () => db.prepare('PRAGMA cipher_version').get(),
    async syncPage(scope: string, transport: Transport, beforeCommit?: () => void) {
      const start = checkpoint(scope);
      const page = record(await (await request(transport, start)).json());
      const next = page['@odata.nextLink'];
      const delta = page['@odata.deltaLink'];
      if ((typeof next === 'string') === (typeof delta === 'string')) throw new Error('Expected exactly one continuation');
      const cursor = string(next ?? delta);
      // Validate before committing an opaque provider continuation.
      if (new URL(cursor).origin !== origin) throw new Error('Untrusted continuation');
      const items = [];
      for (const entry of values(page.value)) {
        const message = record(entry);
        const id = string(message.id);
        if (message['@removed']) throw new Error('Deletion reconciliation outside spike scope');
        const subject = string(message.subject);
        const body = string(record(message.body).content);
        const base = `${origin}/v1.0/me/messages/${encodeURIComponent(id)}`;
        const mime = new Uint8Array(await (await request(transport, `${base}/$value`)).arrayBuffer());
        const attachments = [];
        let attachmentUrl: string | undefined = `${base}/attachments`;
        const visited = new Set<string>();
        while (attachmentUrl) {
          if (visited.has(attachmentUrl)) throw new Error('Attachment pagination cycle');
          visited.add(attachmentUrl);
          const list = record(await (await request(transport, attachmentUrl)).json());
          for (const value of values(list.value)) {
            const attachment = record(value);
            if (attachment['@odata.type'] !== '#microsoft.graph.fileAttachment') throw new Error('Unsupported attachment type');
            const attachmentId = string(attachment.id);
            const bytes = new Uint8Array(await (await request(transport, `${base}/attachments/${encodeURIComponent(attachmentId)}/$value`)).arrayBuffer());
            attachments.push({ id: attachmentId, name: string(attachment.name), bytes });
          }
          attachmentUrl = list['@odata.nextLink'] === undefined ? undefined : string(list['@odata.nextLink']);
        }
        items.push({ id, subject, body, mime, attachments });
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (checkpoint(scope) !== start) throw new Error('Checkpoint changed during fetch');
        for (const item of items) {
          db.prepare('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?)').run(scope,item.id,item.subject,item.body,item.mime,digest(item.mime));
          db.prepare('DELETE FROM attachments WHERE scope=? AND message=?').run(scope,item.id);
          for (const attachment of item.attachments) db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)')
            .run(scope,item.id,attachment.id,attachment.name,attachment.bytes,digest(attachment.bytes));
          db.prepare('DELETE FROM search WHERE scope=? AND id=?').run(scope,item.id);
          db.prepare('INSERT INTO search VALUES (?,?,?,?)').run(scope,item.id,item.subject,item.body);
        }
        db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?,?)').run(scope,cursor);
        beforeCommit?.();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { count: items.length, complete: typeof delta === 'string' };
    },
  };
}
