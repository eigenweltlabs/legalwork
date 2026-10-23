import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { connectorConnectionSchema } from "./schema.js";
import { openSqlite, runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { ensureDir } from "../utils.js";
import { ApiError } from "../errors.js";
import { OAuthVault, oauthVaultPath, vaultLock } from "../file-storage/oauth/vault.js";

const connectionsSchema = z.array(connectorConnectionSchema);
const storedConnectionsSchema = z.array(connectorConnectionSchema.extend({
  nangoConnectionId: z.string().min(1).max(500).optional(),
  bindingId: z.uuid().optional(),
}).refine(connection => Boolean(connection.nangoConnectionId || connection.bindingId)));
export type StoredConnectorConnection = z.infer<typeof storedConnectionsSchema>[number];
const encryptedPrefix = "encrypted:v1:";

const key = (owner: string, id: string) => JSON.stringify(["nango", owner, id]);
const lock = (config: ServerConfig, owner: string, id: string) => `${oauthVaultPath(config)}:${key(owner, id)}`;

export function connectorVault(config: ServerConfig) { return new OAuthVault(oauthVaultPath(config)); }

// SQLite is opened only to import and erase records from the previous store.
// All new writes use the same encrypted vault as file-storage OAuth grants.
async function database(config: ServerConfig) {
  const path = runtimeDbPath(config);
  await ensureDir(dirname(path));
  const db = await openSqlite(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA secure_delete = ON");
    db.exec("CREATE TABLE IF NOT EXISTS connector_connections (owner TEXT NOT NULL, connector_id TEXT NOT NULL, connections_json TEXT NOT NULL, PRIMARY KEY (owner, connector_id))");
  } catch (error) { db.close(); throw error; }
  return db;
}

async function readState(config: ServerConfig, owner: string, id: string) {
  const vault = connectorVault(config);
  let connections = await vault.getEntry(key(owner, id), storedConnectionsSchema);
  const db = await database(config);
  try {
    const row = db.get("SELECT connections_json FROM connector_connections WHERE owner = ? AND connector_id = ?", [owner, id]);
    if (row && connections === undefined) {
      const legacy = z.string().parse(row.connections_json);
      if (legacy.startsWith(encryptedPrefix)) {
        // Read-only compatibility for the brief safeStorage implementation.
        // A failed unlock leaves the original record intact for recovery.
        try {
          if (!config.decryptLegacyConnectorSecrets) throw new Error("Legacy credential storage unavailable");
          connections = storedConnectionsSchema.parse(JSON.parse(await config.decryptLegacyConnectorSecrets(legacy.slice(encryptedPrefix.length))));
        } catch { throw new ApiError(503, "connector_secure_storage_unavailable", "Could not unlock the previous connected-account storage. Restore access before migrating."); }
      } else {
        connections = connectionsSchema.parse(JSON.parse(legacy)).map((connection) => ({ ...connection, id: randomUUID(), nangoConnectionId: connection.id }));
      }
      await vault.setEntry(key(owner, id), storedConnectionsSchema, connections);
    }
    // Write the vault first; a failed migration must never lose a connection.
    // Also finish cleanup after a crash between the vault write and deletion.
    if (row) db.run("DELETE FROM connector_connections WHERE owner = ? AND connector_id = ?", [owner, id]);
  } finally { db.close(); }
  return { connections: connections ?? [], snapshot: connections === undefined ? null : JSON.stringify(connections) };
}

export async function readConnectorState(config: ServerConfig, owner: string, id: string) {
  return vaultLock(lock(config, owner, id), () => readState(config, owner, id));
}

export async function readConnectorConnections(config: ServerConfig, owner: string, id: string) {
  return (await readConnectorState(config, owner, id)).connections;
}

export async function writeConnectorConnections(config: ServerConfig, owner: string, id: string, connections: StoredConnectorConnection[], expectedSnapshot?: string | null, isCurrent?: () => boolean) {
  const parsed = storedConnectionsSchema.parse(connections);
  return vaultLock(lock(config, owner, id), async () => {
    const current = await readState(config, owner, id);
    // Delayed refreshes must not reactivate disconnected or replaced accounts.
    if (expectedSnapshot !== undefined && expectedSnapshot !== current.snapshot) return false;
    return connectorVault(config).setEntry(key(owner, id), storedConnectionsSchema, parsed.length ? parsed : undefined, isCurrent);
  });
}
