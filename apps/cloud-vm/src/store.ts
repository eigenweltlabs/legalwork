import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const UserId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const WorkerSchema = z.object({
  userId: UserId,
  sandboxId: z.string().nullable(),
  template: z.string(),
  clientToken: z.string(),
  hostToken: z.string(),
  synced: z.boolean(),
  state: z.enum(["starting", "running", "paused", "failed"]),
  lastUsedAt: z.number(),
  nextRunAt: z.string().nullable(),
});
export type Worker = z.infer<typeof WorkerSchema>;

export class Store {
  private db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workers (user_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  get(userId: string): Worker | null {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM workers WHERE user_id=?").get(userId);
    return row ? WorkerSchema.parse(JSON.parse(row.data)) : null;
  }
  all(): Worker[] {
    return this.db.query<{ data: string }, []>("SELECT data FROM workers").all().map(row => WorkerSchema.parse(JSON.parse(row.data)));
  }
  save(worker: Worker): void {
    this.db.query("INSERT INTO workers VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data").run(worker.userId, JSON.stringify(worker));
  }
  close(): void { this.db.close(); }
}
