import { z } from "zod";
import { ApiError } from "../errors.js";
import { eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import type { ServerConfig } from "../types.js";
import type { StorageTeamStatus } from "@legalwork/types/file-storage";
import { storageInputSchema, storageSecretKeys } from "./schema.js";
import type { StoredStorage } from "./store.js";
import { StorageInstallations } from "./installations.js";

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string().min(1),
  canManage: z.boolean(),
  connections: z
    .array(
      z.object({
        id: z.string().uuid(),
        version: z.number().int().positive(),
        updatedAt: z.string().datetime(),
        input: storageInputSchema,
        configuredSecrets: z.array(z.enum(storageSecretKeys)).optional(),
      }),
    )
    .max(100),
});
type Identity = { orgId: string; token: string };
type Snapshot = { connections: StoredStorage[]; status: StorageTeamStatus };
const empty = (): Snapshot => ({ connections: [], status: { connected: false, canManage: false } });
const SYNC_MS = 30_000;
export const isTeamStorage = (id: string) => id.startsWith("team:");
export function teamStorageId(id: string) {
  const parsed = z.string().uuid().safeParse(id.slice(5));
  if (!isTeamStorage(id) || !parsed.success) throw new ApiError(400, "invalid_storage_id", "Invalid team connection.");
  return parsed.data;
}
/** Team credentials live only in this process, never in file-storage.json or
 * renderer responses. Authorization is renewed on a bounded 30-second lease.
 * Failures discard the lease; personal connections continue independently.
 */
export class TeamStorage {
  private cache = new Map<string, { identity: Identity; at: number; snapshot: Snapshot }>();
  private configured = new Map<string, string>();
  private pending = new Map<string, Promise<Snapshot>>();
  private generations = new Map<string, number>();
  private installations: StorageInstallations;
  constructor(private config: ServerConfig) {
    this.installations = new StorageInstallations(config);
  }
  async setInstalled(workspaceId: string, storageId: string, installed: boolean) {
    const id = teamStorageId(storageId);
    const connection = (await this.list(workspaceId, true)).connections.find((item) => item.id === storageId);
    if (!connection?.team) throw new ApiError(404, "storage_not_found", "This team connection is unavailable.");
    if (connection.teamInstallation !== "optional") {
      if (!installed)
        throw new ApiError(409, "storage_team_required", "Your admin adds this connection automatically.");
      return;
    }
    await this.installations.set({ workspaceId, orgId: connection.team.orgId, id }, installed);
    this.invalidate(workspaceId);
  }
  private async identity(workspaceId: string): Promise<Identity | null> {
    const token = await ensureFreshPlatformToken(this.config, workspaceId);
    const connection = await readEigenweltConnection(this.config, workspaceId);
    return token && connection.account?.orgId ? { token, orgId: connection.account.orgId } : null;
  }
  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId);
    this.pending.delete(workspaceId);
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1);
  }
  async request(workspaceId: string, method: string, suffix = "", body?: unknown): Promise<unknown> {
    const identity = await this.identity(workspaceId);
    if (!identity)
      throw new ApiError(401, "storage_team_sign_in", "Sign in with your firm to manage team connections.");
    return this.fetch(identity, method, suffix, body);
  }
  private async fetch(identity: Identity, method: string, suffix: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${eigenweltPlatformUrl()}/api/storage-connections${suffix}`, {
        method,
        redirect: "error",
        headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(
        503,
        "storage_team_unavailable",
        "Team connections could not sync. Check your connection and try again.",
      );
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        response.status === 409 ? "storage_settings_conflict" : "storage_team_unavailable",
        response.status === 409
          ? "This connection changed. Refresh and reopen it before saving."
          : response.status === 403
            ? "Your firm membership or plan does not allow this action."
            : "Team connections could not sync. Try again or sign in with your firm.",
      );
    // Validate the feed before replacing any state. Do not expose malformed
    // responses (which may contain credentials) in errors or logs.
    try {
      return await response.json();
    } catch {
      throw new ApiError(502, "storage_team_unavailable", "The team connection response was invalid.");
    }
  }
  async list(workspaceId: string, force = false): Promise<Snapshot> {
    if (force) this.invalidate(workspaceId);
    const running = this.pending.get(workspaceId);
    if (running) return running;
    const generation = this.generations.get(workspaceId) ?? 0;
    const run = this.load(workspaceId, generation).finally(() => {
      if (this.pending.get(workspaceId) === run) this.pending.delete(workspaceId);
    });
    this.pending.set(workspaceId, run);
    return run;
  }
  private async load(workspaceId: string, generation: number): Promise<Snapshot> {
    let identity: Identity | null = null;
    try {
      identity = await this.identity(workspaceId);
      if (!identity) {
        this.cache.delete(workspaceId);
        this.configured.delete(workspaceId);
        return empty();
      }
      if (this.configured.get(workspaceId) !== identity.orgId) this.configured.delete(workspaceId);
      const cached = this.cache.get(workspaceId);
      if (
        cached?.identity.orgId === identity.orgId &&
        cached.identity.token === identity.token &&
        Date.now() - cached.at < SYNC_MS
      )
        return cached.snapshot;
      this.cache.delete(workspaceId);
      const parsed = snapshotSchema.safeParse(await this.fetch(identity, "GET", "/sync"));
      if (
        !parsed.success ||
        parsed.data.orgId !== identity.orgId ||
        new Set(parsed.data.connections.map((item) => item.id)).size !== parsed.data.connections.length
      )
        throw new ApiError(502, "storage_team_unavailable", "The team connection response was invalid.");
      const installations = await this.installations.list();
      const current = await this.identity(workspaceId);
      if (
        !current ||
        current.orgId !== identity.orgId ||
        current.token !== identity.token ||
        generation !== (this.generations.get(workspaceId) ?? 0)
      )
        return empty();
      const snapshot: Snapshot = {
        status: { connected: true, canManage: parsed.data.canManage },
        connections: parsed.data.connections.map((item) => ({
          ...item.input,
          id: `team:${item.id}`,
          workspaceId,
          configuredSecrets: item.configuredSecrets,
          updatedAt: Date.parse(item.updatedAt),
          team: {
            orgId: current.orgId,
            version: item.version,
            installed:
              item.input.teamInstallation !== "optional" ||
              installations.some(
                (installed) =>
                  installed.workspaceId === workspaceId &&
                  installed.orgId === current.orgId &&
                  installed.id === item.id,
              ),
          },
        })),
      };
      if (snapshot.connections.some((item) => item.enabled && item.team?.installed))
        this.configured.set(workspaceId, identity.orgId);
      else this.configured.delete(workspaceId);
      this.cache.set(workspaceId, { identity, snapshot, at: Date.now() });
      return snapshot;
    } catch (error) {
      if (generation !== (this.generations.get(workspaceId) ?? 0)) return empty();
      this.cache.delete(workspaceId);
      // Optional discovery is quiet until this firm actually has shared
      // connections. An unavailable feed must not make personal storage look
      // broken. Explicit admin mutations still return their errors via request.
      if (!this.configured.has(workspaceId)) {
        const snapshot = empty();
        if (identity) this.cache.set(workspaceId, { identity, snapshot, at: Date.now() });
        return snapshot;
      }
      return {
        connections: [],
        status: {
          connected: false,
          canManage: false,
          error: error instanceof ApiError ? error.message : "Team connections could not sync. Try again.",
        },
      };
    }
  }
}
