import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

/** Keys are opaque hashes; request bodies, credentials and commands stay out of this database. */
export interface RememberedApprovalStore {
  has(workspaceId: string, keyHash: string): boolean;
  remember(workspaceId: string, keyHash: string): void;
  forget(workspaceId?: string): void;
  close(): void;
}

export async function openRememberedApprovalStore(config: Pick<ServerConfig, "configPath">): Promise<RememberedApprovalStore> {
  const directory = runtimeStorageDir(config);
  await ensureDir(directory);
  const path = join(directory, "remembered-approvals.sqlite");
  const schema = "CREATE TABLE IF NOT EXISTS remembered_approvals (workspace_id TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id, key_hash))";
  const lookup = "SELECT 1 AS found FROM remembered_approvals WHERE workspace_id = ? AND key_hash = ?";
  const insert = "INSERT OR IGNORE INTO remembered_approvals (workspace_id, key_hash, created_at) VALUES (?, ?, ?)";
  const remove = "DELETE FROM remembered_approvals WHERE workspace_id = ?";
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    try {
      await chmod(path, 0o600);
      db.run(schema);
      const has = db.query(lookup);
      const remember = db.query(insert);
      const forget = db.query(remove);
      return {
        has: (workspaceId, keyHash) => has.get(workspaceId, keyHash) !== null,
        remember: (workspaceId, keyHash) => { remember.run(workspaceId, keyHash, Date.now()); },
        forget: workspaceId => { if (workspaceId === undefined) db.run("DELETE FROM remembered_approvals"); else forget.run(workspaceId); },
        close: () => { has.finalize(); remember.finalize(); forget.finalize(); db.close(); },
      };
    } catch (error) { db.close(); throw error; }
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    db.exec(schema);
    const has = db.prepare(lookup);
    const remember = db.prepare(insert);
    const forget = db.prepare(remove);
    return {
      has: (workspaceId, keyHash) => has.get(workspaceId, keyHash) !== undefined,
      remember: (workspaceId, keyHash) => { remember.run(workspaceId, keyHash, Date.now()); },
      forget: workspaceId => { if (workspaceId === undefined) db.exec("DELETE FROM remembered_approvals"); else forget.run(workspaceId); },
      close: () => db.close(),
    };
  } catch (error) { db.close(); throw error; }
}
