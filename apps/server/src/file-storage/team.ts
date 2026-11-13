import { z } from "zod";
import { ApiError } from "../errors.js";
import { eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import type { ServerConfig } from "../types.js";
import type { StorageRoot, StorageTeamStatus } from "@legalwork/types/file-storage";
import { isCloudStorage } from "./cloud-drives.js";
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
type Identity = { orgId: string; userId: string; token: string };
type Member = Pick<Identity, "orgId" | "userId">;
type DisplayRoot = { root: StorageRoot; ownerOnly: boolean };
type Snapshot = { connections: StoredStorage[]; status: StorageTeamStatus; unavailable?: DisplayRoot[] };
const sameMember = (left: Member | undefined | null, right: Member | undefined | null) =>
  Boolean(left && right && left.orgId === right.orgId && left.userId === right.userId);
const empty = (): Snapshot => ({ connections: [], status: { connected: false, canManage: false } });
const SYNC_MS = 30_000;
class TeamStorageError extends ApiError {
  constructor(status: number, code: string, message: string, readonly reason: string) {
    super(status, code, message);
  }
}
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
  // Names only: never retain usable credentials after a failed authorization lease.
  private display = new Map<string, { identity: Member; roots: DisplayRoot[] }>();
  private configured = new Map<string, Member>();
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
  private async identity(): Promise<Identity | null> {
    const token = await ensureFreshPlatformToken(this.config);
    return token ? this.storedIdentity() : null;
  }
  private async storedIdentity(): Promise<Identity | null> {
    const connection = await readEigenweltConnection(this.config);
    return connection.platformToken && connection.account?.orgId
      ? { token: connection.platformToken, orgId: connection.account.orgId, userId: connection.account.userId } : null;
  }
  private clear(workspaceId: string) {
    this.cache.delete(workspaceId);
    this.configured.delete(workspaceId);
    this.display.delete(workspaceId);
  }
  private diagnostic(workspaceId: string, reason: string, error?: unknown) {
    console.warn("[storage.team.sync]", JSON.stringify({ workspaceId, reason,
      ...(error instanceof ApiError ? { status: error.status, code: error.code } : {}),
      ...(error instanceof TeamStorageError ? { failure: error.reason } : {}),
    }));
  }
  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId);
    this.pending.delete(workspaceId);
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1);
  }
  async request(workspaceId: string, method: string, suffix = "", body?: unknown): Promise<unknown> {
    const identity = await this.identity();
    if (!identity)
      throw new ApiError(401, "storage_team_sign_in", "Sign in with your firm to manage team connections.");
    return this.fetch(identity, method, suffix, body);
  }
  async accessToken(workspaceId: string, storageId: string, version: number, forceRefresh: boolean) {
    const response = await this.request(workspaceId, "POST", `/${teamStorageId(storageId)}/token`, { version, forceRefresh });
    const parsed = z.object({ accessToken: z.string().min(1) }).safeParse(response);
    if (!parsed.success) throw new ApiError(502, "storage_team_unavailable", "The team account response was invalid.");
    return parsed.data.accessToken;
  }
  private async fetch(identity: Identity, method: string, suffix: string, body?: unknown): Promise<unknown> {
    let response: Response;
    const signal = AbortSignal.timeout(15_000);
    try {
      response = await fetch(`${eigenweltPlatformUrl()}/api/storage-connections${suffix}`, {
        method,
        redirect: "error",
        headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json", "X-LegalWork-Storage-Capabilities": "native-cloud-sharing-v1" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch {
      throw new TeamStorageError(
        503,
        "storage_team_unavailable",
        "Team connections could not sync. Check your connection and try again.",
        signal.aborted ? "timeout" : "network_error",
      );
    }
    if (!response.ok)
      throw new TeamStorageError(
        response.status,
        response.status === 409 ? "storage_settings_conflict" : "storage_team_unavailable",
        response.status === 409
          ? "This connection changed. Refresh and reopen it before saving."
          : response.status === 403
            ? "Your firm membership or plan does not allow this action."
            : "Team connections could not sync. Try again or sign in with your firm.",
        "upstream_http",
      );
    // Validate the feed before replacing any state. Do not expose malformed
    // responses (which may contain credentials) in errors or logs.
    try {
      return await response.json();
    } catch {
      throw new TeamStorageError(502, "storage_team_unavailable", "The team connection response was invalid.", signal.aborted ? "timeout" : "invalid_json");
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
  private async load(workspaceId: string, generation: number, retries = 1): Promise<Snapshot> {
    let identity: Identity | null = null;
    try {
      identity = await this.identity();
      if (generation !== (this.generations.get(workspaceId) ?? 0)) return empty();
      if (!identity) {
        this.clear(workspaceId);
        return empty();
      }
      if (!sameMember(this.configured.get(workspaceId), identity)) this.configured.delete(workspaceId);
      const display = this.display.get(workspaceId);
      if (display && !sameMember(display.identity, identity)) this.display.delete(workspaceId);
      const cached = this.cache.get(workspaceId);
      if (
        cached && sameMember(cached.identity, identity) &&
        cached.identity.token === identity.token &&
        Date.now() - cached.at < SYNC_MS
      )
        return cached.snapshot;
      this.cache.delete(workspaceId);
      const parsed = snapshotSchema.safeParse(await this.fetch(identity, "GET", "/sync"));
      if (
        !parsed.success ||
        parsed.data.orgId !== identity.orgId ||
        parsed.data.connections.some(item => item.input.secrets.nangoConnectionId !== undefined || item.input.secrets.nangoOwnerId !== undefined) ||
        new Set(parsed.data.connections.map((item) => item.id)).size !== parsed.data.connections.length
      )
        throw new TeamStorageError(502, "storage_team_unavailable", "The team connection response was invalid.", "invalid_feed");
      const installations = await this.installations.list();
      const current = await this.identity();
      if (generation !== (this.generations.get(workspaceId) ?? 0))
        return empty();
      if (!current || !sameMember(current, identity)) {
        this.clear(workspaceId);
        this.diagnostic(workspaceId, "member_changed");
        return empty();
      }
      if (current.token !== identity.token) {
        this.diagnostic(workspaceId, "token_rotated");
        if (retries) return this.load(workspaceId, generation, retries - 1);
        throw new ApiError(503, "storage_team_unavailable", "Team authorization changed while syncing. Try again.");
      }
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
        this.configured.set(workspaceId, { orgId: current.orgId, userId: current.userId });
      else this.configured.delete(workspaceId);
      this.display.set(workspaceId, {
        identity: { orgId: current.orgId, userId: current.userId },
        roots: snapshot.connections.filter(item => item.enabled && item.team?.installed &&
          !(isCloudStorage(item.config) && item.config.provider === "sharepoint-files" && !item.config.driveId))
          .map(item => ({
            root: { id: item.id, name: item.name, kind: item.config.kind, writable: false,
              ...(item.config.kind === "oauth" ? { provider: item.config.provider } : {}),
            },
            ownerOnly: isCloudStorage(item.config) && item.config.sharingMode !== "team",
          })),
      });
      this.cache.set(workspaceId, { identity, snapshot, at: Date.now() });
      return snapshot;
    } catch (error) {
      if (generation !== (this.generations.get(workspaceId) ?? 0)) return empty();
      this.cache.delete(workspaceId);
      const current = await this.storedIdentity();
      if (generation !== (this.generations.get(workspaceId) ?? 0)) return empty();
      if (!current || !sameMember(current, identity)) {
        this.clear(workspaceId);
        this.diagnostic(workspaceId, "member_changed", error);
        return empty();
      }
      if (identity && current.token !== identity.token && retries) {
        this.diagnostic(workspaceId, "token_rotated_after_failure", error);
        return this.load(workspaceId, generation, retries - 1);
      }
      this.diagnostic(workspaceId, "discovery_failed", error);
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.display.delete(workspaceId);
      // Optional discovery is quiet until this firm actually has shared
      // connections. An unavailable feed must not make personal storage look
      // broken. Explicit admin mutations still return their errors via request.
      if (!this.configured.has(workspaceId)) {
        const snapshot = empty();
        if (identity) this.cache.set(workspaceId, { identity, snapshot, at: Date.now() });
        return snapshot;
      }
      const unavailable = this.display.get(workspaceId)?.roots;
      return {
        connections: [],
        ...(unavailable?.length ? { unavailable } : {}),
        status: {
          connected: false,
          canManage: false,
          error: error instanceof ApiError ? error.message : "Team connections could not sync. Try again.",
        },
      };
    }
  }
}
