import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PermissionActionSchema, type PermissionAction, type PermissionRule } from "./org-policy-schema.js";

import { firmHubConnectorBlocks } from "./firm-hub.js";
import { appliedOrgPolicy } from "./org-policy.js";
import { orgChatProviderBlocks, orgEnabledProviders } from "./org-policy-ai.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

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
  return join(runtimeStorageDir(config), "org-policy-engine");
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
  own: Record<string, unknown>,
): Promise<{ permission: Record<string, unknown>; enforced: Record<string, PermissionRule> }> {
  const entry = await appliedOrgPolicy(config, "tools.permissions");
  const permission = { ...own };
  const enforced: Record<string, PermissionRule> = {};
  for (const [tool, rule] of Object.entries(entry?.value ?? {})) {
    if (rule === undefined) continue;
    enforced[tool] = enforcedRule(rule, own[tool]);
    permission[tool] = enforced[tool];
  }
  return { permission, enforced };
}

/**
 * The folder's config: empty while the firm enforces nothing here and gives
 * no connectors. The firm's skills sit beside it (firm-hub.ts).
 */
export async function buildOrgPolicyEngineLayer(
  config: ServerConfig,
  own: { permission: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const { enforced } = await orgPolicyPermissions(config, own.permission);
  const layer: Record<string, unknown> = {};
  if (Object.keys(enforced).length > 0) {
    layer.permission = enforced;
    // A project's own definition of the default agent could carry looser rules.
    layer.agent = { legalwork: { permission: enforced } };
  }
  const providers = await orgChatProviderBlocks(config);
  if (Object.keys(providers).length > 0) layer.provider = providers;
  const connectors = await firmHubConnectorBlocks(config);
  if (Object.keys(connectors).length > 0) layer.mcp = connectors;
  // While the firm allows no chat providers of the member's own, only Eigenwelt's and the firm's.
  const enabledProviders = await orgEnabledProviders(config);
  if (enabledProviders) layer.enabled_providers = enabledProviders;
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
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, serializeLayer(layer), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
