import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { FirmHubAccess, FirmHubItem, FirmHubKind, FirmHubView } from "@legalwork/types/firm-hub";

import { announceSyncChange } from "./app-sync-events.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { hubGet, hubGetSecret, hubListAll, installSkillFiles, requireHubClient, type EigenweltHubItem } from "./eigenwelt-hub.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { ApiError } from "./errors.js";
import { OcrVault } from "./ocr/vault.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig, SkillItem } from "./types.js";

/**
 * The firm's Knowledge Hub on this computer: what its admin installed for
 * everyone, and what the member added of what the firm offers. LegalWork
 * follows the hub and copies none of it into the member's own config:
 * - connectors go in the firm's engine folder (org-policy-engine.ts), with
 *   the firm's key, the member's own, or the member's own sign-in;
 * - skills and workflows go in that folder as files (`skills/<name>/`),
 *   which the engine reads like any config folder's;
 * - prompt sets show in the review library, beside the built-in ones.
 * The firm's switches for members' own items leave these alone. A change on
 * the platform pokes this computer (`{"hub":true}`); the last catalog heard
 * is kept for a restart, the firm's keys only in memory, and on sign-out
 * everything of the firm's goes. What the member added and their own keys
 * stay theirs, for the next sign-in.
 */

const KINDS: readonly FirmHubKind[] = ["mcp", "skill", "workflow", "review_set"];
/** Pulls asked for more often than this (polls, focus) wait for the next one. */
const SYNC_THROTTLE_MS = 10_000;

type CatalogItem = {
  id: string;
  kind: FirmHubKind;
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  installation: "automatic" | "optional";
  hasSecret: boolean;
  canAccessSecret: boolean;
};
type Catalog = { orgId: string; items: CatalogItem[] };
type Change = "engine" | "app";

const CatalogSchema = z.object({
  orgId: z.string(),
  items: z.array(z.object({
    id: z.string(),
    kind: z.enum(["mcp", "skill", "workflow", "review_set"]),
    name: z.string(),
    description: z.string(),
    version: z.number(),
    updatedAt: z.string(),
    installation: z.enum(["automatic", "optional"]),
    hasSecret: z.boolean(),
    canAccessSecret: z.boolean(),
  })),
});
const AddedSchema = z.object({ orgId: z.string(), ids: z.array(z.string()) });
const CachedSchema = z.object({ version: z.number(), payload: z.unknown() });
const MarkerSchema = z.object({ id: z.string(), version: z.number() });
const ConnectorSchema = z.object({
  key: z.string().min(1),
  mcp: z.union([
    z.object({ type: z.literal("remote"), url: z.string() }).passthrough(),
    z.object({ type: z.literal("local"), command: z.array(z.string()) }).passthrough(),
  ]),
  access: z.object({
    by: z.enum(["none", "firm", "member", "oauth"]),
    name: z.string().optional(),
    client: z.object({ id: z.string(), scope: z.string().optional() }).optional(),
  }).optional(),
});
type Connector = z.infer<typeof ConnectorSchema>;
const MARKER = ".firm-hub.json";

type Runtime = {
  /** The firm's keys of its connectors, by item: only while signed in. */
  secrets: Map<string, { version: number; value: string }>;
  vault: OcrVault;
  handlers: Set<(changes: Set<Change>) => void>;
  running: Promise<void> | null;
  rerun: boolean;
  lastSyncAt: number;
};
const runtimes = new Map<string, Runtime>();

const hubDir = (config: ServerConfig) => join(runtimeStorageDir(config), "firm-hub");
const skillsDir = (config: ServerConfig) => join(orgPolicyEngineDir(config), "skills");
const cachePath = (config: ServerConfig, id: string) => join(hubDir(config), "items", `${id.replace(/[^A-Za-z0-9-]/g, "")}.json`);

function runtimeFor(config: ServerConfig): Runtime {
  const key = hubDir(config);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = {
      secrets: new Map(),
      vault: new OcrVault(join(key, "keys.vault"), "connector"),
      handlers: new Set(),
      running: null,
      rerun: false,
      lastSyncAt: 0,
    };
    runtimes.set(key, runtime);
  }
  return runtime;
}

async function readJson<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T> | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function connectedOrgId(config: ServerConfig): Promise<string | null> {
  const connection = await readEigenweltConnection(config);
  return connection.platformToken && connection.account?.orgId ? connection.account.orgId : null;
}

/** The catalog of the firm signed in to, or null. */
async function activeCatalog(config: ServerConfig): Promise<Catalog | null> {
  const catalog = await readJson(join(hubDir(config), "catalog.json"), CatalogSchema);
  const orgId = await connectedOrgId(config);
  return catalog && orgId === catalog.orgId ? catalog : null;
}

async function addedIds(config: ServerConfig, orgId: string): Promise<Set<string>> {
  const added = await readJson(join(hubDir(config), "added.json"), AddedSchema);
  return new Set(added?.orgId === orgId ? added.ids : []);
}

/**
 * What this computer installs: everything installed for everyone, and what
 * the member added. One per name where they would collide (skills and
 * workflows share the skills folder): what everyone gets first, then the newest.
 */
function wantedItems(items: CatalogItem[], added: Set<string>): CatalogItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => item.installation === "automatic" || added.has(item.id))
    .sort((a, b) => (a.installation === b.installation ? b.updatedAt.localeCompare(a.updatedAt) : a.installation === "automatic" ? -1 : 1))
    .filter((item) => {
      const key = `${item.kind === "workflow" ? "skill" : item.kind}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function wanted(config: ServerConfig): Promise<CatalogItem[]> {
  const catalog = await activeCatalog(config);
  return catalog ? wantedItems(catalog.items, await addedIds(config, catalog.orgId)) : [];
}

async function cachedPayload(config: ServerConfig, item: CatalogItem): Promise<unknown> {
  const cached = await readJson(cachePath(config, item.id), CachedSchema);
  return cached?.version === item.version ? cached.payload : undefined;
}

function catalogItem(item: EigenweltHubItem & { kind: FirmHubKind }): CatalogItem {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    description: item.description ?? "",
    version: item.version,
    updatedAt: item.updatedAt,
    // An older platform says nothing: members add what it offers themselves.
    installation: item.installation ?? "optional",
    hasSecret: item.hasSecret === true,
    canAccessSecret: item.canAccessSecret === true,
  };
}

const isFirmKind = (item: EigenweltHubItem): item is EigenweltHubItem & { kind: FirmHubKind } =>
  KINDS.some((kind) => kind === item.kind);

/** The skill folders as the wanted items have them: written where new or changed, gone where no longer wanted. */
async function syncSkillFolders(config: ServerConfig, items: CatalogItem[]): Promise<boolean> {
  const dir = skillsDir(config);
  const skills = items.filter((item) => item.kind === "skill" || item.kind === "workflow");
  let changed = false;
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !skills.some((item) => item.name === entry.name)) {
      await rm(join(dir, entry.name), { recursive: true, force: true });
      changed = true;
    }
  }
  for (const item of skills) {
    const marker = await readJson(join(dir, item.name, MARKER), MarkerSchema);
    if (marker?.id === item.id && marker.version === item.version) continue;
    const payload = await cachedPayload(config, item);
    const files = z.object({ files: z.array(z.unknown()) }).safeParse(payload);
    if (!files.success) continue;
    await rm(join(dir, item.name), { recursive: true, force: true });
    try {
      await installSkillFiles(dir, item.name, files.data.files);
      await writeJson(join(dir, item.name, MARKER), { id: item.id, version: item.version });
    } catch (error) {
      console.warn(`[firm-hub] skill ${item.name} not installed: ${error instanceof Error ? error.message : String(error)}`);
    }
    changed = true;
  }
  return changed;
}

/** Everything of the firm's goes: its catalog, what it installed, its keys. */
async function clear(config: ServerConfig): Promise<void> {
  runtimeFor(config).secrets.clear();
  await rm(join(hubDir(config), "catalog.json"), { force: true });
  await rm(join(hubDir(config), "items"), { recursive: true, force: true });
  await rm(skillsDir(config), { recursive: true, force: true });
}

/** What the engine and the windows see of the hub, to tell whether a pull changed it. */
async function fingerprint(config: ServerConfig): Promise<{ engine: string; app: string }> {
  const catalog = await activeCatalog(config);
  const items = await wanted(config);
  const runtime = runtimeFor(config);
  return {
    engine: JSON.stringify({
      items: items.filter((item) => item.kind !== "review_set").map((item) => [item.id, item.version]),
      secrets: [...runtime.secrets].map(([id, secret]) => [id, secret.version]).sort(),
    }),
    app: JSON.stringify({ catalog, added: catalog ? [...(await addedIds(config, catalog.orgId))].sort() : [] }),
  };
}

async function syncOnce(config: ServerConfig): Promise<void> {
  const runtime = runtimeFor(config);
  const before = await fingerprint(config);
  const orgId = await connectedOrgId(config);
  if (!orgId) {
    await clear(config);
  } else {
    await pull(config, runtime, orgId);
  }
  const after = await fingerprint(config);
  const changes = new Set<Change>();
  if (before.engine !== after.engine) changes.add("engine");
  if (before.app !== after.app || changes.has("engine")) changes.add("app");
  if (changes.size === 0) return;
  announceSyncChange(config, "hub");
  for (const handler of runtime.handlers) handler(changes);
}

async function pull(config: ServerConfig, runtime: Runtime, orgId: string): Promise<void> {
  const token = await ensureFreshPlatformToken(config).catch(() => null);
  const connection = await readEigenweltConnection(config);
  if (!token || !connection.platformToken) return;
  let client: ReturnType<typeof requireHubClient>;
  let listed: EigenweltHubItem[];
  try {
    client = requireHubClient(connection);
    listed = await hubListAll(client);
  } catch (error) {
    // No hub in the firm's plan: nothing of it applies. Otherwise keep what is known.
    if (error instanceof ApiError && error.status === 403) await clear(config);
    return;
  }
  // A sign-out or account switch may have won the race.
  if ((await connectedOrgId(config)) !== orgId) return;
  const items = listed.filter(isFirmKind).map(catalogItem);
  await writeJson(join(hubDir(config), "catalog.json"), { orgId, items } satisfies Catalog);
  const want = wantedItems(items, await addedIds(config, orgId));

  for (const item of want) {
    try {
      const marker = item.kind === "skill" || item.kind === "workflow"
        ? await readJson(join(skillsDir(config), item.name, MARKER), MarkerSchema)
        : null;
      const current = marker?.id === item.id && marker.version === item.version;
      if (!current && (await cachedPayload(config, item)) === undefined) {
        const detail = await hubGet(client, item.id);
        await writeJson(cachePath(config, item.id), { version: detail.version, payload: detail.payload });
      }
      if (item.kind === "mcp" && item.hasSecret && item.canAccessSecret) {
        if (runtime.secrets.get(item.id)?.version !== item.version) {
          const secret = await hubGetSecret(client, item.id);
          if (secret) runtime.secrets.set(item.id, { version: item.version, value: secret });
          else runtime.secrets.delete(item.id);
        }
      } else {
        runtime.secrets.delete(item.id);
      }
    } catch (error) {
      // Tried again on the next pull; what was installed stays meanwhile.
      console.warn(`[firm-hub] ${item.kind} ${item.name} not pulled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // What is no longer wanted goes, with its key; skill files once installed need no copy.
  for (const id of [...runtime.secrets.keys()]) if (!want.some((item) => item.id === id)) runtime.secrets.delete(id);
  try {
    const keep = new Set(want.map((item) => basename(cachePath(config, item.id))));
    for (const name of await readdir(join(hubDir(config), "items"))) {
      if (!keep.has(name)) await rm(join(hubDir(config), "items", name), { force: true });
    }
  } catch {
    // No cache yet.
  }
  await syncSkillFolders(config, want);
}

/**
 * Pull the hub now (or soon, when one runs). Unforced pulls closer together
 * than SYNC_THROTTLE_MS are skipped. Also called after a sign-in or sign-out.
 */
export function scheduleFirmHubSync(config: ServerConfig, options: { force?: boolean } = {}): Promise<void> {
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
          console.warn(`[firm-hub] sync failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } while (runtime.rerun);
    } finally {
      runtime.running = null;
    }
  })();
  return runtime.running;
}

/** Hear what changed (`engine`: the engine config needs a rebuild); returns the unsubscribe. */
export function onFirmHubChange(config: ServerConfig, handler: (changes: Set<Change>) => void): () => void {
  const handlers = runtimeFor(config).handlers;
  handlers.add(handler);
  return () => handlers.delete(handler);
}

async function connectorOf(config: ServerConfig, item: CatalogItem): Promise<Connector | null> {
  const parsed = ConnectorSchema.safeParse(await cachedPayload(config, item));
  return parsed.success ? parsed.data : null;
}

function accessOf(item: CatalogItem, connector: Connector): FirmHubAccess {
  // A share from LegalWork says nothing of it: with its key, or each member signs in.
  return connector.access?.by ?? (item.hasSecret ? "firm" : connector.mcp.type === "remote" ? "oauth" : "none");
}

/**
 * The engine's entry for a firm connector, or null until it can be used: the
 * firm's key has not come, or the member has not added their own.
 */
function connectorEntry(item: CatalogItem, connector: Connector, secret: string | undefined, ownKey: string | undefined): Record<string, unknown> | null {
  const { mcp, access } = connector;
  // The firm's key or OAuth app, or a key shared from LegalWork: the whole entry.
  if (secret) {
    try {
      const entry: unknown = JSON.parse(secret);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) return { ...entry, enabled: true };
    } catch {
      return null;
    }
  }
  const by = accessOf(item, connector);
  if (by === "firm") return null;
  if (by === "member") {
    if (!ownKey) return null;
    const name = access?.name ?? "Authorization";
    return mcp.type === "remote"
      ? { ...mcp, oauth: false, headers: { [name]: ownKey }, enabled: true }
      : { ...mcp, environment: { [name]: ownKey }, enabled: true };
  }
  if (by === "oauth" && access?.client) {
    const { id, scope } = access.client;
    return { ...mcp, oauth: { clientId: id, ...(scope ? { scope } : {}) }, enabled: true };
  }
  return { ...mcp, enabled: true };
}

/** The engine's entries for the firm's connectors that can be used now, by name. */
export async function firmHubConnectorBlocks(config: ServerConfig): Promise<Record<string, unknown>> {
  const runtime = runtimeFor(config);
  const blocks: Record<string, unknown> = {};
  for (const item of (await wanted(config)).filter((each) => each.kind === "mcp")) {
    const connector = await connectorOf(config, item);
    if (!connector) continue;
    const entry = connectorEntry(item, connector, runtime.secrets.get(item.id)?.value, await runtime.vault.get(item.id));
    if (entry) blocks[connector.key] = entry;
  }
  return blocks;
}

/** The names the firm's connectors run under: the firm's switch for members' own leaves them alone. */
export async function firmHubConnectorNames(config: ServerConfig): Promise<Set<string>> {
  const names = new Set<string>();
  for (const item of (await wanted(config)).filter((each) => each.kind === "mcp")) {
    const connector = await connectorOf(config, item);
    if (connector) names.add(connector.key);
  }
  return names;
}

/** The firm's skills and workflows installed on this computer, for the lists. */
export async function firmHubSkills(config: ServerConfig): Promise<SkillItem[]> {
  const skills: SkillItem[] = [];
  for (const item of await wanted(config)) {
    if (item.kind !== "skill" && item.kind !== "workflow") continue;
    const marker = await readJson(join(skillsDir(config), item.name, MARKER), MarkerSchema);
    if (marker?.id !== item.id) continue;
    skills.push({
      name: item.name,
      path: join(skillsDir(config), item.name, "SKILL.md"),
      description: item.description,
      scope: "global",
      ...(item.kind === "workflow" ? { kind: "workflow" as const, workflowType: "assistant" as const } : {}),
      firm: item.installation,
    });
  }
  return skills;
}

/** The firm's prompt sets for the review library: its payload `{ set }`. */
export async function firmHubPromptSets(config: ServerConfig): Promise<Array<{ id: string; version: number; payload: unknown }>> {
  const sets: Array<{ id: string; version: number; payload: unknown }> = [];
  for (const item of await wanted(config)) {
    if (item.kind !== "review_set") continue;
    const payload = await cachedPayload(config, item);
    if (payload !== undefined) sets.push({ id: item.id, version: item.version, payload });
  }
  return sets;
}

export async function readFirmHubView(config: ServerConfig): Promise<FirmHubView> {
  const catalog = await activeCatalog(config);
  if (!catalog) return { connected: false, items: [] };
  const runtime = runtimeFor(config);
  const added = await addedIds(config, catalog.orgId);
  const items: FirmHubItem[] = [];
  for (const item of catalog.items) {
    const connector = item.kind === "mcp" ? await connectorOf(config, item) : null;
    items.push({
      id: item.id,
      kind: item.kind,
      name: item.name,
      description: item.description,
      installation: item.installation,
      added: added.has(item.id),
      ...(connector
        ? { connector: { access: accessOf(item, connector), keyName: connector.access?.name ?? null, hasOwnKey: Boolean(await runtime.vault.get(item.id)) } }
        : {}),
    });
  }
  return { connected: true, items };
}

/** The member adds an item the firm offers, or removes it again. */
export async function setFirmHubAdded(config: ServerConfig, id: string, add: boolean): Promise<FirmHubView> {
  const catalog = await activeCatalog(config);
  const item = catalog?.items.find((each) => each.id === id);
  if (!catalog || !item) throw new ApiError(404, "firm_hub_item_not_found", "Your firm no longer offers this.");
  if (item.installation === "automatic") {
    throw new ApiError(409, "firm_hub_installed_for_everyone", "Your admin installed this for everyone.");
  }
  const ids = await addedIds(config, catalog.orgId);
  if (add) ids.add(id);
  else ids.delete(id);
  await writeJson(join(hubDir(config), "added.json"), { orgId: catalog.orgId, ids: [...ids] });
  await scheduleFirmHubSync(config, { force: true });
  return readFirmHubView(config);
}

/** The member's own key for a firm connector that asks each member for theirs; null removes it. */
export async function setFirmHubMemberKey(config: ServerConfig, id: string, key: string | null): Promise<FirmHubView> {
  const runtime = runtimeFor(config);
  const item = (await wanted(config)).find((each) => each.id === id && each.kind === "mcp");
  const connector = item ? await connectorOf(config, item) : null;
  if (!item || !connector || accessOf(item, connector) !== "member") {
    throw new ApiError(404, "firm_hub_item_not_found", "This connector takes no key of yours.");
  }
  await runtime.vault.set(id, key ?? undefined);
  for (const handler of runtime.handlers) handler(new Set<Change>(["engine", "app"]));
  announceSyncChange(config, "hub");
  return readFirmHubView(config);
}

/** Tests: forget the in-memory state for a runtime folder. */
export function resetFirmHubRuntimeForTests(config: ServerConfig): void {
  runtimes.delete(hubDir(config));
}
