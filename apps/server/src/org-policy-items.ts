import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import {
  hubGet,
  hubGetSecret,
  installFolderFiles,
  parseIntegrationPayload,
  parsePluginPayload,
  parseSharedMcpSecret,
  requireHubClient,
  validateHubName,
} from "./eigenwelt-hub.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { ApiError } from "./errors.js";
import { appliedOrgPolicy, readOrgPolicyState, readOrgPolicyView, requireOrgPolicyAllows } from "./org-policy.js";
import type { ServerConfig } from "./types.js";

/**
 * The Firm Hub items the firm's policy installs for every member: connectors
 * (`connectors.managed`), plugins and skills or workflows. They live in the
 * firm's config folder, which the engine reads like any config folder
 * (`skills/`, `plugins/`, and the `mcp`/`plugin` entries of its config), with
 * `items.json` listing what is there. A connector's shared credential stays
 * in memory while signed in. Items arrive and update while signed in, stay
 * after a sign-out, and leave when the firm drops them, the member takes the
 * setting back, or another firm's policy arrives.
 */

type ManagedKind = "mcp" | "plugin" | "skill";
type ManagedItem = {
  id: string;
  kind: ManagedKind;
  name: string;
  version: number;
  /** Connectors: the server name and its entry without credentials. */
  mcp?: { key: string; config: Record<string, unknown> };
  /** Plugins installed by spec (npm or URL). */
  spec?: string;
  /** Files written under the folder, removed with the item. */
  files?: string[];
};
type Manifest = { orgId: string; items: ManagedItem[] };

/** The firm's connectors' credentials, per folder. */
const credentials = new Map<string, { orgId: string; byItem: Record<string, Record<string, unknown>> }>();

function manifestPath(dir: string): string {
  return join(dir, "items.json");
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath(dir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("orgId" in parsed) || !("items" in parsed)) return null;
    return typeof parsed.orgId === "string" && Array.isArray(parsed.items) ? { orgId: parsed.orgId, items: parsed.items } : null;
  } catch {
    return null;
  }
}

async function writeManifest(dir: string, manifest: Manifest | null): Promise<void> {
  if (!manifest) {
    await rm(manifestPath(dir), { force: true });
    return;
  }
  await mkdir(dir, { recursive: true });
  const temporary = `${manifestPath(dir)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, manifestPath(dir));
}

async function removeFiles(dir: string, item: ManagedItem): Promise<void> {
  for (const file of item.files ?? []) await rm(join(dir, file), { recursive: true, force: true });
}

/** The ids the policy installs now, with the kind each must be. */
async function wantedItems(config: ServerConfig): Promise<Map<string, ManagedKind>> {
  const wanted = new Map<string, ManagedKind>();
  for (const id of (await appliedOrgPolicy(config, "connectors.managed"))?.value ?? []) wanted.set(id, "mcp");
  for (const id of (await appliedOrgPolicy(config, "plugins.managed"))?.value ?? []) wanted.set(id, "plugin");
  for (const id of (await appliedOrgPolicy(config, "skills.managed"))?.value ?? []) wanted.set(id, "skill");
  return wanted;
}

function kindOf(hubKind: string): ManagedKind | null {
  if (hubKind === "mcp" || hubKind === "integration") return "mcp";
  if (hubKind === "plugin") return "plugin";
  if (hubKind === "skill" || hubKind === "workflow") return "skill";
  return null;
}

/** Bring the folder's items in line with the policy; returns whether anything changed. */
export async function syncOrgPolicyItems(config: ServerConfig, dir: string): Promise<boolean> {
  const view = await readOrgPolicyView(config);
  const wanted = await wantedItems(config);
  let manifest = await readManifest(dir);
  let changed = false;
  // Another firm's policy, or none: the previous firm's items go.
  if (manifest && manifest.orgId !== view.orgId) {
    for (const item of manifest.items) await removeFiles(dir, item);
    manifest = null;
    changed = true;
  }
  const items = new Map((manifest?.items ?? []).map((item) => [item.id, item]));
  for (const [id, item] of items) {
    if (wanted.get(id) === item.kind) continue;
    await removeFiles(dir, item);
    items.delete(id);
    changed = true;
  }

  const active = (await readOrgPolicyState(config)) === "active";
  const own = credentials.get(dir);
  const byItem = active && own?.orgId === view.orgId ? { ...own.byItem } : {};
  if (active && view.orgId && wanted.size > 0) {
    await ensureFreshPlatformToken(config).catch(() => null);
    const client = requireHubClient(await readEigenweltConnection(config));
    for (const [id, kind] of wanted) {
      try {
        const item = await hubGet(client, id);
        if (kindOf(item.kind) !== kind) continue;
        const existing = items.get(id);
        if (existing?.version !== item.version) {
          if (existing) await removeFiles(dir, existing);
          items.set(id, await install(dir, { id, kind, name: item.name, version: item.version }, item.payload));
          changed = true;
        }
        if (kind === "mcp" && item.hasSecret && item.canAccessSecret && !byItem[id]) {
          const secret = await hubGetSecret(client, id);
          if (secret) {
            byItem[id] = parseSharedMcpSecret(secret);
            changed = true;
          }
        }
      } catch (error) {
        // Unreachable or no longer shared: what is installed stays until the next round.
        console.warn(`[org-policy] could not install hub item ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (Object.keys(own?.byItem ?? {}).length !== Object.keys(byItem).length) changed = true;
  if (view.orgId && Object.keys(byItem).length > 0) credentials.set(dir, { orgId: view.orgId, byItem });
  else credentials.delete(dir);
  if (changed) await writeManifest(dir, view.orgId && items.size > 0 ? { orgId: view.orgId, items: [...items.values()] } : null);
  return changed;
}

async function install(dir: string, item: ManagedItem, payload: unknown): Promise<ManagedItem> {
  if (item.kind === "mcp") {
    const { key, mcp } = parseIntegrationPayload(payload);
    return { ...item, mcp: { key, config: mcp } };
  }
  const files = typeof payload === "object" && payload !== null && "files" in payload ? payload.files : null;
  if (item.kind === "skill") {
    const name = validateHubName(item.name, "skill");
    await installFolderFiles(join(dir, "skills", name), files);
    return { ...item, files: [join("skills", name)] };
  }
  const plugin = parsePluginPayload(payload);
  if ("spec" in plugin) return { ...item, spec: plugin.spec };
  await installFolderFiles(join(dir, "plugins"), plugin.files);
  return { ...item, files: plugin.files.map((file) => join("plugins", file.path)) };
}

/** The connectors (with credentials while signed in) and plugin specs the folder's config adds. */
export async function orgPolicyItemsLayer(config: ServerConfig, dir: string): Promise<{ mcp: Record<string, unknown>; plugin: string[] }> {
  const manifest = await readManifest(dir);
  const active = (await readOrgPolicyState(config)) === "active";
  const own = credentials.get(dir);
  const secrets = active && own?.orgId === manifest?.orgId ? own?.byItem : undefined;
  const mcp: Record<string, unknown> = {};
  const plugin: string[] = [];
  for (const item of manifest?.items ?? []) {
    if (item.mcp) mcp[item.mcp.key] = secrets?.[item.id] ?? item.mcp.config;
    if (item.spec) plugin.push(item.spec);
  }
  return { mcp, plugin };
}

/** LegalWork's own connectors: not the member's, so the firm's switch for those leaves them alone. */
export const BUILT_IN_CONNECTORS = new Set(["computer-use", "legalwork-ui"]);

/**
 * The connectors the firm allows: the member's own unless it allows none,
 * and LegalWork's own unless it switched off that built-in extension.
 */
export async function allowedMemberConnectors<T>(config: ServerConfig, mcp: Record<string, T>): Promise<Record<string, T>> {
  const custom = (await appliedOrgPolicy(config, "connectors.allowCustom"))?.value !== false;
  const builtIn: Record<string, boolean | undefined> = (await appliedOrgPolicy(config, "extensions.builtIn"))?.value ?? {};
  return Object.fromEntries(Object.entries(mcp).filter(([name]) => (BUILT_IN_CONNECTORS.has(name) ? builtIn[name] !== false : custom)));
}

/** Refuses adding a connector the firm does not allow. */
export async function requireConnectorAllowed(config: ServerConfig, name: string): Promise<void> {
  if (!BUILT_IN_CONNECTORS.has(name)) return requireOrgPolicyAllows(config, "connectors.allowCustom");
  const builtIn: Record<string, boolean | undefined> = (await appliedOrgPolicy(config, "extensions.builtIn"))?.value ?? {};
  if (builtIn[name] === false) throw new ApiError(403, "org_policy_disallowed", "Your organization has switched off this extension.", { key: "extensions.builtIn" });
}

/** Refuses installing a Firm Hub item of a kind the firm allows members no own of. */
export async function requireHubInstallAllowed(config: ServerConfig, hubKind: string): Promise<void> {
  const kind = kindOf(hubKind);
  if (kind) await requireOrgPolicyAllows(config, kind === "mcp" ? "connectors.allowCustom" : kind === "plugin" ? "plugins.allowCustom" : "skills.allowCustom");
}

/** The firm's connectors as shared, without their credentials. */
export async function orgPolicyConnectors(dir: string): Promise<Array<{ name: string; config: Record<string, unknown> }>> {
  return ((await readManifest(dir))?.items ?? []).flatMap((item) => (item.mcp ? [{ name: item.mcp.key, config: item.mcp.config }] : []));
}
