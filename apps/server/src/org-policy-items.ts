import { ApiError } from "./errors.js";
import { appliedOrgPolicy, requireOrgPolicyAllows } from "./org-policy.js";
import type { ServerConfig } from "./types.js";

/** Firm Hub kinds, by the switch that lets members add their own. */
function kindOf(hubKind: string): "mcp" | "plugin" | "skill" | null {
  if (hubKind === "mcp" || hubKind === "integration") return "mcp";
  if (hubKind === "plugin") return "plugin";
  if (hubKind === "skill" || hubKind === "workflow") return "skill";
  return null;
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
