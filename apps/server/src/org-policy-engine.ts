import { mkdir, readFile } from "node:fs/promises";
import { writeGeneratedConfigFile } from "./generated-config-file.js";
import { join } from "node:path";
import { PermissionActionSchema, type PermissionAction, type PermissionRule } from "./org-policy-schema.js";

import { firmHubConnectorBlocks } from "./firm-hub.js";
import { appliedOrgPolicy } from "./org-policy.js";
import { orgChatProviderBlocks, orgEnabledProviders } from "./org-policy-ai.js";
import { engineStorageDir } from "./engine-storage.js";
import type { ServerConfig } from "./types.js";
import type { Config } from "@opencode/schema/config";
import { permissionAction } from "./agent-sandbox/permissions.js";
type NativePermission = NonNullable<(typeof Config.Info.Type)["permissions"]>[number];

/**
 * What the firm's policy changes in the engine. Two layers:
 * - The runtime config file (OPENCODE_CONFIG) carries the settings in effect,
 *   the member's and the firm's together.
 * - A config folder of its own (OPENCODE_CONFIG_DIR) carries what the firm
 *   enforces. The engine reads it after every project's own config
 *   (`opencode.json`, `.opencode/`), so a project file, whether written by hand
 *   or by an agent, cannot loosen it. It is rewritten from the policy with the
 *   runtime config file, before every reload the server makes, and the guard
 *   plugin blocks what the policy denies even if the folder was changed.
 */

export function orgPolicyEngineDir(config: ServerConfig): string {
  return join(engineStorageDir(config), "org-policy-engine");
}

function orgPolicyEngineFile(config: ServerConfig): string {
  return join(orgPolicyEngineDir(config), "opencode.json");
}

const STRICTNESS: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * An enforced rule is the minimum: where both are plain actions, the
 * member's stricter one stays; otherwise the firm's rule applies as it is.
 */
function enforcedRule(firm: PermissionRule, own: unknown): PermissionRule {
  const ownAction = PermissionActionSchema.safeParse(own);
  if (typeof firm !== "string" || !ownAction.success) return firm;
  return STRICTNESS[ownAction.data] > STRICTNESS[firm] ? ownAction.data : firm;
}

/**
 * The tool permissions in effect: the member's, with the firm's rules
 * applied, and the firm's rules alone (for the folder).
 */
export async function orgPolicyPermissions(
  config: ServerConfig,
  own: readonly NativePermission[],
): Promise<{ permission: NativePermission[]; enforced: NativePermission[] }> {
  const entry = await appliedOrgPolicy(config, "tools.permissions");
  const permission = [...own];
  const enforced: NativePermission[] = [];
  for (const [tool, rule] of Object.entries(entry?.value ?? {})) {
    if (rule === undefined) continue;
    const action = tool === "bash" ? "shell" : tool;
    const effective = enforcedRule(rule, permissionAction(own, action, "*"));
    const rules = typeof effective === "string" ? [["*", effective]] : Object.entries(effective);
    for (const [resource, effect] of rules) {
      if (effect !== "allow" && effect !== "ask" && effect !== "deny") throw new Error("Invalid organization tool permission.");
      const value: NativePermission = { action, resource: String(resource), effect };
      enforced.push(value);
      permission.push(value);
    }
  }
  return { permission, enforced };
}

/**
 * The folder's config: empty while the firm enforces nothing here and gives
 * no connectors. The firm's skills sit beside it (firm-hub.ts).
 */
export async function buildOrgPolicyEngineLayer(
  config: ServerConfig,
  own: { permissions: readonly NativePermission[] },
): Promise<Record<string, unknown>> {
  const { enforced } = await orgPolicyPermissions(config, own.permissions);
  const layer: Record<string, unknown> = {};
  if (enforced.length > 0) {
    layer.permissions = enforced;
    // A project's own definition of the default agent could carry looser rules.
    const agents = { legalwork: { permissions: enforced } };
    layer.agents = agents;
  }
  const providers = await orgChatProviderBlocks(config);
  if (Object.keys(providers).length > 0) layer.providers = providers;
  const connectors = await firmHubConnectorBlocks(config);
  if (Object.keys(connectors).length > 0) layer.mcp = { servers: connectors };
  // While the firm allows no chat providers of the member's own, only Eigenwelt's and the firm's.
  const enabledProviders = await orgEnabledProviders(config);
  if (enabledProviders) layer.policies = [{ action: "provider.use", resource: "*", effect: "deny" }, ...enabledProviders.map(resource => ({ action: "provider.use", resource, effect: "allow" }))];
  return layer;
}

// The engine adds a `$schema` line to a config file without one; with it
// already there, the file stays exactly as written.
function serializeLayer(layer: Record<string, unknown>): string {
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", ...layer });
}

/** Whether the folder holds exactly `layer`. */
export async function orgPolicyEngineLayerIntact(config: ServerConfig, layer: Record<string, unknown>): Promise<boolean> {
  try {
    return (await readFile(orgPolicyEngineFile(config), "utf8")) === serializeLayer(layer);
  } catch {
    return false;
  }
}

export async function writeOrgPolicyEngineLayer(config: ServerConfig, layer: Record<string, unknown>): Promise<void> {
  const path = orgPolicyEngineFile(config);
  await mkdir(orgPolicyEngineDir(config), { recursive: true });
  await writeGeneratedConfigFile(path, serializeLayer(layer));
}
