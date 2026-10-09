import { dirname } from "node:path";
import {
  ORG_POLICY_KEYS,
  OrgPolicySecretsSchema,
  OrgPolicySnapshotSchema,
  isOrgPolicyKey,
  orgPolicyDefinitions,
  orgPolicySecretRefs,
  parseOrgPolicyEntries,
  type OrgPolicyEntry,
  type OrgPolicyKey,
  type OrgPolicyScope,
  type OrgPolicySnapshot,
} from "./org-policy-schema.js";
import type { OrgPolicyState, OrgPolicyView } from "@legalwork/types/org-policy-view";

import { announceSyncChange } from "./app-sync-events.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { ApiError } from "./errors.js";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

/**
 * The firm's policy on this computer: the settings and permissions its admin
 * set on the platform (packages/types/src/org-policy.ts). The last policy
 * heard is kept in runtime.sqlite and outlives a sign-out:
 * - `active`: signed in to the firm the policy is from. Enforced settings are
 *   locked; nothing here can unlock them.
 * - `lapsed`: signed out (or signed in elsewhere, until that firm's policy
 *   arrives). Everything still applies, and the member may take a setting
 *   back (`releaseOrgPolicyKey`) after the app told them it is the firm's.
 * A setting in `default` mode can be taken back at any time. Signing in to
 * the same firm again puts the enforced ones back.
 *
 * The secrets the policy refers to (API keys of the firm's providers) stay in
 * memory while signed in and are never kept after a sign-out.
 *
 * The platform pokes this computer when the policy changes; the entitlements
 * poll asks too. Each pull is conditional, so an unchanged policy costs a 304.
 */

export type { OrgPolicyState, OrgPolicyView };
export type AppliedOrgPolicyEntry<K extends OrgPolicyKey> = OrgPolicyEntry<K> & { locked: boolean };

type Restored = NonNullable<OrgPolicyView["restored"]>;
type Stored = { snapshot: OrgPolicySnapshot; released: Set<OrgPolicyKey>; restored: Restored | null };
type Secrets = { orgId: string; revision: number; values: Record<string, string> };

const REQUEST_TIMEOUT_MS = 15_000;
/** Pulls asked for more often than this (polls, focus) wait for the next one. */
const SYNC_THROTTLE_MS = 10_000;

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS org_policy (id TEXT PRIMARY KEY NOT NULL, snapshot_json TEXT NOT NULL, released_json TEXT NOT NULL, restored_json TEXT, updated_at INTEGER NOT NULL)";
const ROW_ID = "current";

type Runtime = {
  db: Promise<SqliteHandle>;
  stored: Stored | null | undefined;
  secrets: Secrets | null;
  lastState: OrgPolicyState | null;
  handlers: Set<(scopes: Set<OrgPolicyScope>) => void>;
  running: Promise<void> | null;
  rerun: boolean;
  lastSyncAt: number;
};

const runtimes = new Map<string, Runtime>();

function runtimeFor(config: ServerConfig): Runtime {
  const path = runtimeDbPath(config);
  let runtime = runtimes.get(path);
  if (!runtime) {
    runtime = {
      db: (async () => {
        await ensureDir(dirname(path));
        const db = await openSqlite(path);
        db.exec(CREATE_TABLE_SQL);
        return db;
      })(),
      stored: undefined,
      secrets: null,
      lastState: null,
      handlers: new Set(),
      running: null,
      rerun: false,
      lastSyncAt: 0,
    };
    runtimes.set(path, runtime);
  }
  return runtime;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readStored(config: ServerConfig): Promise<Stored | null> {
  const runtime = runtimeFor(config);
  if (runtime.stored !== undefined) return runtime.stored;
  const row = (await runtime.db).get("SELECT snapshot_json, released_json, restored_json FROM org_policy WHERE id = ?", [ROW_ID]);
  const snapshot = OrgPolicySnapshotSchema.safeParse(parseJson(row?.snapshot_json));
  const released = parseJson(row?.released_json);
  const restored = parseJson(row?.restored_json);
  runtime.stored = snapshot.success
    ? {
        snapshot: { ...snapshot.data, entries: parseOrgPolicyEntries(snapshot.data.entries) },
        released: new Set(Array.isArray(released) ? released.filter((key) => typeof key === "string" && isOrgPolicyKey(key)) : []),
        restored:
          typeof restored === "object" && restored !== null && "at" in restored && "count" in restored &&
          typeof restored.at === "number" && typeof restored.count === "number"
            ? { at: restored.at, count: restored.count }
            : null,
      }
    : null;
  return runtime.stored;
}

async function writeStored(config: ServerConfig, stored: Stored): Promise<void> {
  const runtime = runtimeFor(config);
  (await runtime.db).run(
    "INSERT INTO org_policy (id, snapshot_json, released_json, restored_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, released_json = excluded.released_json, restored_json = excluded.restored_json, updated_at = excluded.updated_at",
    [ROW_ID, JSON.stringify(stored.snapshot), JSON.stringify([...stored.released]), stored.restored ? JSON.stringify(stored.restored) : null, Date.now()],
  );
  runtime.stored = stored;
}

async function connectedOrg(config: ServerConfig): Promise<{ orgId: string; platformURL: string } | null> {
  const connection = await readEigenweltConnection(config);
  const orgId = connection.account?.orgId;
  return connection.platformToken && orgId && connection.platformURL ? { orgId, platformURL: connection.platformURL } : null;
}

function stateOf(stored: Stored | null, org: { orgId: string } | null): OrgPolicyState {
  if (!stored || Object.keys(stored.snapshot.entries).length === 0) return "none";
  return org?.orgId === stored.snapshot.orgId ? "active" : "lapsed";
}

export async function readOrgPolicyState(config: ServerConfig): Promise<OrgPolicyState> {
  return stateOf(await readStored(config), await connectedOrg(config));
}

/**
 * The firm's setting for `key` as it applies now: null when the firm does not
 * manage it or the member took it back.
 */
export async function appliedOrgPolicy<K extends OrgPolicyKey>(
  config: ServerConfig,
  key: K,
): Promise<AppliedOrgPolicyEntry<K> | null> {
  const stored = await readStored(config);
  const entry = stored?.snapshot.entries[key];
  if (!stored || !entry || stored.released.has(key)) return null;
  const state = stateOf(stored, await connectedOrg(config));
  return { ...entry, locked: state === "active" && entry.mode === "enforced" };
}

/** Refuses a change to a setting the firm manages (the app takes it back first, where it may). */
export async function requireOrgPolicyUnmanaged(config: ServerConfig, key: OrgPolicyKey): Promise<void> {
  if (!(await appliedOrgPolicy(config, key))) return;
  const stored = await readStored(config);
  throw new ApiError(403, "org_policy_managed", `This setting is managed by ${stored?.snapshot.orgName || "your organization"}.`, { key });
}

/** Refuses a change to tool permissions the firm manages. */
export async function requireOrgPolicyToolsUnmanaged(config: ServerConfig, tools: string[]): Promise<void> {
  const entry = await appliedOrgPolicy(config, "tools.permissions");
  const managed = Object.entries(entry?.value ?? {}).flatMap(([tool, rule]) => (rule === undefined ? [] : [tool]));
  if (tools.some((tool) => managed.includes(tool))) await requireOrgPolicyUnmanaged(config, "tools.permissions");
}

/** Refuses an action the firm switched off with a boolean setting (`false`). */
export async function requireOrgPolicyAllows(config: ServerConfig, key: OrgPolicyKey): Promise<void> {
  const entry = await appliedOrgPolicy(config, key);
  if (entry?.value !== false) return;
  const stored = await readStored(config);
  throw new ApiError(403, "org_policy_disallowed", `${stored?.snapshot.orgName || "Your organization"} does not allow this.`, { key });
}

/** The member takes a setting back: always for a default, for an enforced one only once signed out. */
export async function releaseOrgPolicyKey(config: ServerConfig, key: OrgPolicyKey): Promise<void> {
  const stored = await readStored(config);
  const entry = stored?.snapshot.entries[key];
  if (!stored || !entry || stored.released.has(key)) return;
  if (entry.mode === "enforced" && stateOf(stored, await connectedOrg(config)) === "active") {
    throw new ApiError(403, "org_policy_locked", `This setting is enforced by ${stored.snapshot.orgName || "your organization"}.`, { key });
  }
  await writeStored(config, { ...stored, released: new Set([...stored.released, key]) });
  notify(config, new Set([orgPolicyDefinitions[key].scope]));
}

/** A secret the policy refers to, while signed in to its firm. */
export async function orgPolicySecret(config: ServerConfig, ref: string): Promise<string | null> {
  const secrets = runtimeFor(config).secrets;
  const stored = await readStored(config);
  if (!secrets || !stored || secrets.orgId !== stored.snapshot.orgId || stateOf(stored, await connectedOrg(config)) !== "active") return null;
  return secrets.values[ref] ?? null;
}

export async function readOrgPolicyView(config: ServerConfig): Promise<OrgPolicyView> {
  const stored = await readStored(config);
  const connection = await readEigenweltConnection(config);
  const state = stateOf(stored, await connectedOrg(config));
  if (!stored) {
    return { state, orgId: null, orgName: null, role: null, revision: 0, platformURL: connection.platformURL, entries: {}, restored: null };
  }
  const entries: Record<string, unknown> = {};
  for (const key of ORG_POLICY_KEYS) {
    const entry = stored.snapshot.entries[key];
    if (!entry) continue;
    entries[key] = { ...entry, locked: state === "active" && entry.mode === "enforced" && !stored.released.has(key), released: stored.released.has(key) };
  }
  return {
    state,
    orgId: stored.snapshot.orgId,
    orgName: stored.snapshot.orgName,
    role: state === "active" ? stored.snapshot.role : null,
    revision: stored.snapshot.revision,
    platformURL: connection.platformURL,
    entries: viewEntries(entries),
    restored: stored.restored,
  };
}

// Built from the parsed entries above, key by key.
function viewEntries(entries: Record<string, unknown>): OrgPolicyView["entries"] {
  return entries as OrgPolicyView["entries"];
}

/** Hear which scopes changed (`engine` changes need the engine config rebuilt); returns the unsubscribe. */
export function onOrgPolicyChange(config: ServerConfig, handler: (scopes: Set<OrgPolicyScope>) => void): () => void {
  const handlers = runtimeFor(config).handlers;
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function notify(config: ServerConfig, scopes: Set<OrgPolicyScope>): void {
  if (scopes.size === 0) return;
  announceSyncChange(config, "policy");
  for (const handler of runtimeFor(config).handlers) handler(scopes);
}

/** The scopes whose applied settings differ between two policies. */
function changedScopes(before: Stored | null, beforeState: OrgPolicyState | null, after: Stored | null, afterState: OrgPolicyState): Set<OrgPolicyScope> {
  const scopes = new Set<OrgPolicyScope>();
  for (const key of ORG_POLICY_KEYS) {
    const old = before?.released.has(key) ? undefined : before?.snapshot.entries[key];
    const next = after?.released.has(key) ? undefined : after?.snapshot.entries[key];
    const lockChanged = (beforeState === "active") !== (afterState === "active") && (old?.mode === "enforced" || next?.mode === "enforced");
    if (lockChanged || JSON.stringify(old) !== JSON.stringify(next)) scopes.add(orgPolicyDefinitions[key].scope);
  }
  return scopes;
}

async function fetchJson(url: string, token: string, init: { etag?: string } = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.etag ? { "If-None-Match": init.etag } : {}) },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, body: null };
  }
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function syncOnce(config: ServerConfig): Promise<void> {
  const runtime = runtimeFor(config);
  const before = await readStored(config);
  const beforeSecrets = runtime.secrets;
  let after = before;
  let org = await connectedOrg(config);
  if (org) {
    const token = await ensureFreshPlatformToken(config).catch(() => null);
    org = await connectedOrg(config);
    if (token && org) after = await pull(config, org, token, before);
  }
  const afterState = stateOf(after, await connectedOrg(config));
  // Signed out, or another firm: the previous firm's secrets go now.
  if (runtime.secrets && (afterState !== "active" || runtime.secrets.orgId !== after?.snapshot.orgId)) runtime.secrets = null;
  const scopes = changedScopes(before, runtime.lastState, after, afterState);
  // Only the values matter: knowing there are none (after a start) changes nothing.
  if (JSON.stringify(beforeSecrets?.values ?? {}) !== JSON.stringify(runtime.secrets?.values ?? {})) scopes.add("engine").add("server");
  if (runtime.lastState !== null && runtime.lastState !== afterState) scopes.add("app");
  runtime.lastState = afterState;
  notify(config, scopes);
}

async function pull(config: ServerConfig, org: { orgId: string; platformURL: string }, token: string, before: Stored | null): Promise<Stored | null> {
  const base = org.platformURL.replace(/\/+$/, "");
  const sameOrg = before?.snapshot.orgId === org.orgId;
  let result: { status: number; body: unknown };
  try {
    result = await fetchJson(`${base}/api/desktop/policy`, token, sameOrg ? { etag: `"${before.snapshot.revision}"` } : {});
  } catch {
    return before;
  }
  let snapshot = before?.snapshot ?? null;
  if (result.status === 200) {
    const parsed = OrgPolicySnapshotSchema.safeParse(result.body);
    if (!parsed.success || parsed.data.orgId !== org.orgId) return before;
    snapshot = { ...parsed.data, entries: parseOrgPolicyEntries(parsed.data.entries) };
  } else if (result.status !== 304 || !sameOrg) {
    // An older platform without policies, or a failed pull: keep what is known.
    return before;
  }
  if (!snapshot) return before;
  // Signed in to the firm: what the member took back of its enforced settings
  // goes back (counted once, for the app to say so); defaults they changed stay theirs.
  const released = new Set<OrgPolicyKey>();
  let restoredCount = 0;
  for (const key of sameOrg ? before.released : []) {
    const entry = snapshot.entries[key];
    if (entry?.mode === "default") released.add(key);
    else if (entry) restoredCount += 1;
  }
  // Re-check after the request: a sign-out or account switch may have won the race.
  const current = await connectedOrg(config);
  if (current?.orgId !== org.orgId) return before;
  const next: Stored = {
    snapshot,
    released,
    restored: restoredCount > 0 ? { at: Date.now(), count: restoredCount } : sameOrg ? before.restored : null,
  };
  if (JSON.stringify(next.snapshot) !== JSON.stringify(before?.snapshot) || next.released.size !== before?.released.size || next.restored !== before?.restored) {
    await writeStored(config, next);
  }
  await pullSecrets(config, base, token, next.snapshot);
  return next;
}

async function pullSecrets(config: ServerConfig, base: string, token: string, snapshot: OrgPolicySnapshot): Promise<void> {
  const runtime = runtimeFor(config);
  if (orgPolicySecretRefs(snapshot.entries).length === 0) {
    runtime.secrets = { orgId: snapshot.orgId, revision: snapshot.revision, values: {} };
    return;
  }
  if (runtime.secrets?.orgId === snapshot.orgId && runtime.secrets.revision === snapshot.revision) return;
  try {
    const result = await fetchJson(`${base}/api/desktop/policy/secrets`, token);
    const parsed = OrgPolicySecretsSchema.safeParse(result.body);
    if (result.status === 200 && parsed.success && (await connectedOrg(config))?.orgId === snapshot.orgId) {
      runtime.secrets = { orgId: snapshot.orgId, revision: parsed.data.revision, values: parsed.data.secrets };
    }
  } catch {
    // Retried on the next pull; the firm's providers wait for their keys meanwhile.
  }
}

/**
 * Pull the policy now (or soon, when one runs). Unforced pulls closer together
 * than SYNC_THROTTLE_MS are skipped. Also called after a sign-in or sign-out,
 * which changes what applies even without a pull.
 */
export function scheduleOrgPolicySync(config: ServerConfig, options: { force?: boolean } = {}): Promise<void> {
  const runtime = runtimeFor(config);
  if (!options.force && Date.now() - runtime.lastSyncAt < SYNC_THROTTLE_MS) return runtime.running ?? Promise.resolve();
  if (runtime.running) {
    runtime.rerun = true;
    return runtime.running;
  }
  runtime.lastSyncAt = Date.now();
  runtime.running = (async () => {
    try {
      do {
        runtime.rerun = false;
        await syncOnce(config).catch((error) => {
          console.warn(`[org-policy] sync failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } while (runtime.rerun);
    } finally {
      runtime.running = null;
    }
  })();
  return runtime.running;
}

/** Tests: forget the in-memory state for a runtime DB. */
export async function resetOrgPolicyRuntimeForTests(config: ServerConfig): Promise<void> {
  const path = runtimeDbPath(config);
  const runtime = runtimes.get(path);
  if (!runtime) return;
  await runtime.running;
  (await runtime.db).close();
  runtimes.delete(path);
}
