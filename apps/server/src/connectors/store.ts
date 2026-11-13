import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { connectorConnectionSchema } from "./schema.js";
import { openSqlite, runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { beginNativeConfigComponent, completeNativeConfigComponent } from "../runtime-opencode-config-store.js";
import { OAuthVault, oauthVaultPath, vaultLock } from "../file-storage/oauth/vault.js";
import { connectorEntryDigest, connectorStorageStatePath, missingFile, readConnectorStorageState, requireConnectorStorageState, writeConnectorStorageState } from "./storage-state.js";
import { prepareConnectorSettings } from "./settings.js";
import { invalidateConnectorCredentials } from "./credential-cache.js";

const connectionsSchema = z.array(connectorConnectionSchema.strict());
const storedConnectionsSchema = z.array(connectorConnectionSchema.extend({
  nangoConnectionId: z.string().min(1).max(500).optional(),
  bindingId: z.uuid().optional(),
}).strict().refine(connection => Boolean(connection.nangoConnectionId || connection.bindingId)));
export type StoredConnectorConnection = z.infer<typeof storedConnectionsSchema>[number];
const legacyRow = z.object({ owner: z.string(), connector_id: z.string(), connections_json: z.string() });
const encryptedPrefix = "encrypted:v1:";
const key = (owner: string, id: string) => JSON.stringify(["nango", owner, id]);
const sourceDigest = (rows: z.infer<typeof legacyRow>[]) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
export function connectorVault(config: ServerConfig) { return new OAuthVault(oauthVaultPath(config)); }
const recovery = () => new ApiError(503, "connector_storage_recovery_required", "Saved connector storage is incomplete or conflicts with its previous store. Restore the original profile before reconnecting.");

async function legacyDatabase(config: ServerConfig) {
  const path = runtimeDbPath(config);
  try { await stat(path); } catch (error) { if (missingFile(error)) return undefined; throw error; }
  const db = await openSqlite(path);
  db.exec("PRAGMA busy_timeout = 5000"); db.exec("PRAGMA secure_delete = ON");
  return db;
}
async function previousConnections(config: ServerConfig, value: string) {
  if (!value.startsWith(encryptedPrefix)) {
    try { return connectionsSchema.parse(JSON.parse(value)).map(connection => ({ ...connection, id: randomUUID(), nangoConnectionId: connection.id })); }
    catch { throw new ApiError(503, "connector_legacy_storage_invalid", "The previous connected-account record could not be migrated without discarding data. Its original contents have been preserved."); }
  }
  try {
    if (!config.decryptLegacyConnectorSecrets) throw recovery();
    return storedConnectionsSchema.parse(JSON.parse(await config.decryptLegacyConnectorSecrets(value.slice(encryptedPrefix.length))));
  } catch { throw new ApiError(503, "connector_secure_storage_unavailable", "Could not unlock the previous connected-account storage. Restore access before migrating; the original record has been preserved."); }
}
async function currentEntryDigests(vault: OAuthVault) {
  const names = await vault.entryNames(storedConnectionsSchema, entry => {
    let parts: unknown;
    try { parts = JSON.parse(entry); } catch { return false; }
    return Array.isArray(parts) && parts.length === 3 && parts[0] === "nango" && typeof parts[1] === "string" && typeof parts[2] === "string";
  });
  return names.map(connectorEntryDigest);
}
function sameLegacy(current: StoredConnectorConnection[], original: StoredConnectorConnection[], encrypted: boolean) {
  const identity = (values: StoredConnectorConnection[]) => encrypted ? values : values.map(({ id, ...value }) => value);
  return JSON.stringify(identity(current)) === JSON.stringify(identity(original));
}

/** One explicit startup transition. Ordinary connector reads never open SQLite. */
export async function prepareConnectorStorage(config: ServerConfig) {
  return vaultLock(connectorStorageStatePath(config), async () => {
    const component = "connector-storage." + connectorEntryDigest(resolve(oauthVaultPath(config)));
    const phase = await beginNativeConfigComponent(config, component);
    const vault = connectorVault(config);
    let state = await readConnectorStorageState(config);
    if (phase === "complete" && !state) throw recovery();
    if (state && !await vault.prepared()) throw recovery();
    await vault.prepare();
    if (state?.phase === "complete") {
      const completed = state;
      const actual = await currentEntryDigests(vault);
      if (completed.connections.some(key => !actual.includes(key) && !(completed.pending?.key === key && !completed.pending.present))) throw recovery();
      await prepareConnectorSettings(config, completed.settingsExpected);
      if (completed.pending || actual.some(key => !completed.connections.includes(key))) await writeConnectorStorageState(config, { ...completed, connections: actual.sort(), pending: undefined });
      await completeNativeConfigComponent(config, component);
      return;
    }
    const db = await legacyDatabase(config);
    try {
      const table = db?.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_connections'");
      const rows = table && db ? z.array(legacyRow).parse(db.all("SELECT owner, connector_id, connections_json FROM connector_connections ORDER BY owner, connector_id")) : [];
      if (state?.legacySourceDigest && sourceDigest(rows) !== state.legacySourceDigest && table) throw recovery();
      const expected = new Set(state?.connections ?? []);
      for (const row of rows) {
        const entry = key(row.owner, row.connector_id);
        const original = await previousConnections(config, row.connections_json);
        let current = await vault.getEntry(entry, storedConnectionsSchema);
        if (current !== undefined && !sameLegacy(current, original, row.connections_json.startsWith(encryptedPrefix))) throw recovery();
        if (current === undefined) {
          await vault.setEntry(entry, storedConnectionsSchema, original);
          current = await vault.getEntry(entry, storedConnectionsSchema);
        }
        if (JSON.stringify(current) !== JSON.stringify(original) && (current === undefined || !sameLegacy(current, original, false))) throw recovery();
        expected.add(connectorEntryDigest(entry));
      }
      const actual = await currentEntryDigests(vault);
      if ([...expected].some(key => !actual.includes(key))) throw recovery();
      for (const key of actual) expected.add(key);
      const settingsExpected = await prepareConnectorSettings(config, state?.settingsExpected ?? false, true);
      state = { version: 1, phase: "retiring", connections: [...expected].sort(), settingsExpected, legacySourceDigest: state?.legacySourceDigest ?? sourceDigest(rows) };
      await writeConnectorStorageState(config, state);
      if (table && db) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const currentRows = z.array(legacyRow).parse(db.all("SELECT owner, connector_id, connections_json FROM connector_connections ORDER BY owner, connector_id"));
          if (sourceDigest(currentRows) !== state.legacySourceDigest) throw recovery();
          db.exec("DROP TABLE connector_connections"); db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      // Retire plaintext WAL frames too; do not vacuum or rewrite unrelated tables.
      const checkpoint = db?.get("PRAGMA wal_checkpoint(TRUNCATE)");
      if (checkpoint && checkpoint.busy !== 0) throw recovery();
      await writeConnectorStorageState(config, { ...state, phase: "complete" });
      await completeNativeConfigComponent(config, component);
    } finally { db?.close(); }
  });
}

async function readState(config: ServerConfig, owner: string, id: string) {
  const state = await requireConnectorStorageState(config);
  const vault = connectorVault(config);
  if (!await vault.prepared()) throw recovery();
  const connections = await vault.getEntry(key(owner, id), storedConnectionsSchema);
  const digest = connectorEntryDigest(key(owner, id));
  if (connections === undefined && state.connections.includes(digest) && !(state.pending?.key === digest && !state.pending.present)) throw recovery();
  return { connections: connections ?? [], snapshot: connections === undefined ? null : JSON.stringify(connections) };
}
export async function readConnectorState(config: ServerConfig, owner: string, id: string) {
  return vaultLock(connectorStorageStatePath(config), () => readState(config, owner, id));
}
export async function readConnectorConnections(config: ServerConfig, owner: string, id: string) {
  return (await readConnectorState(config, owner, id)).connections;
}
export async function writeConnectorConnections(config: ServerConfig, owner: string, id: string, connections: StoredConnectorConnection[], expectedSnapshot?: string | null, isCurrent?: () => boolean) {
  const parsed = storedConnectionsSchema.parse(connections);
  return vaultLock(connectorStorageStatePath(config), async () => {
    const current = await readState(config, owner, id);
    if (expectedSnapshot !== undefined && expectedSnapshot !== current.snapshot) return false;
    if (JSON.stringify(parsed) !== JSON.stringify(current.connections)) invalidateConnectorCredentials(config);
    const state = await requireConnectorStorageState(config);
    const digest = connectorEntryDigest(key(owner, id));
    await writeConnectorStorageState(config, { ...state, pending: { key: digest, present: parsed.length > 0 } });
    const stored = await connectorVault(config).setEntry(key(owner, id), storedConnectionsSchema, parsed.length ? parsed : undefined, isCurrent);
    const expected = new Set(state.connections);
    if (stored) { if (parsed.length) expected.add(digest); else expected.delete(digest); }
    await writeConnectorStorageState(config, { ...state, connections: [...expected].sort(), pending: undefined });
    return stored;
  });
}
