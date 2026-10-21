import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { OAuthClientInformationSchema, OAuthTokensSchema } from "@modelcontextprotocol/core";
import { ApiError } from "./errors.js";
import { OAuthVault, oauthVaultPath } from "./file-storage/oauth/vault.js";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export const remoteMcpSchema = z.object({
  type: z.literal("remote"), url: z.string().url(), enabled: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(), timeout: z.number().positive().optional(),
  oauth: z.union([z.literal(false), z.object({
    clientId: z.string().optional(), clientSecret: z.string().optional(), scope: z.string().optional(),
    callbackPort: z.number().int().min(1).max(65535).optional(), redirectUri: z.string().url().optional(),
  })]).optional(),
});
export type RemoteMcp = z.infer<typeof remoteMcpSchema>;
export const FIRM_MCP_SCOPE = "__firm_mcp__:";
const recordSchema = z.object({
  id: z.uuid(), key: z.string(), revision: z.uuid(), config: remoteMcpSchema,
  client: OAuthClientInformationSchema.optional(), tokens: OAuthTokensSchema.optional(),
  expiresAt: z.number().finite().optional(), reconnectRequired: z.boolean().optional(),
  issuer: z.string().url().optional(), requiredScope: z.string().optional(),
  configurationHash: z.string().optional(),
  legacyMigration: z.string().optional(),
  legacyHandoffPending: z.boolean().optional(),
});
export type ManagedMcpRecord = z.infer<typeof recordSchema>;
const recordsSchema = z.record(z.string(), recordSchema);
const vaultEntry = "managed-mcp";
export function isMcpSecureStorageError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code.startsWith("mcp_secure_storage_");
}

/** A dedicated SQLite write transaction is an OS-released, crash-safe owner lock.
 * It never locks the application's runtime database or a network request's transaction. */
export class McpManagerStore {
  readonly path: string;
  private vault: OAuthVault;
  private owner?: SqliteHandle;
  private records: Record<string, ManagedMcpRecord> = {};
  private sourceConfigurations = new Map<string, RemoteMcp>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: ServerConfig) {
    this.path = oauthVaultPath(config);
    this.vault = new OAuthVault(this.path);
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const owner = await openSqlite(`${this.path}.mcp-owner.sqlite`);
    try { owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); }
    catch { owner.close(); throw new ApiError(409, "mcp_manager_in_use", "Another LegalWork server owns this connector store."); }
    this.owner = owner;
    try {
      await this.vault.ready();
      this.records = await this.vault.getEntry(vaultEntry, recordsSchema) ?? {};
    } catch {
      this.close();
      throw new ApiError(503, "mcp_secure_storage_unreadable", "Saved connector credentials could not be opened. Restore access to the app encryption key before reconnecting.");
    }
  }

  get(key: string) {
    const record = this.records[key];
    return record ? structuredClone({ ...record, config: this.sourceConfigurations.get(key) ?? record.config }) : undefined;
  }
  all() { return Object.keys(this.records).flatMap(key => { const record = this.get(key); return record ? [record] : []; }); }
  hydrate(key: string, config: RemoteMcp) { this.sourceConfigurations.set(key, structuredClone(config)); }

  async put(record: ManagedMcpRecord) {
    // Firm-managed secrets remain source-owned and memory-only. Persist the
    // member's OAuth grant, not the firm's API key or configured client secret.
    const sourceOwned = record.key.startsWith(`["${FIRM_MCP_SCOPE}`);
    const stored = sourceOwned ? { ...record, config: { ...record.config, headers: undefined,
      oauth: record.config.oauth ? { ...record.config.oauth, clientSecret: undefined } : record.config.oauth } } : record;
    await this.mutate(records => { records[record.key] = recordSchema.parse(stored); });
    if (sourceOwned) this.hydrate(record.key, record.config);
  }
  async remove(key: string) { await this.mutate(records => { delete records[key]; }); this.sourceConfigurations.delete(key); }

  private async mutate(update: (records: Record<string, ManagedMcpRecord>) => void) {
    const job = this.queue.then(async () => {
      if (!this.owner) throw new Error("MCP credential store is closed.");
      const next = structuredClone(this.records);
      update(next);
      // The shared vault merges this namespace under its write lock, preserving
      // file-storage grants and built-in connector capabilities written meanwhile.
      await this.vault.setEntry(vaultEntry, recordsSchema, next);
      this.records = next;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async drain() { await this.queue; }
  close() { this.owner?.close(); this.owner = undefined; this.records = {}; this.sourceConfigurations.clear(); }
}
