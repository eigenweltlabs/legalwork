import { homedir } from "node:os";
import { join } from "node:path";
import { permissionPatternMatches, type NativePermissionRule, type PermissionAction } from "./agent-sandbox/permissions.js";

const home = (path: string) => path === "~" || path === "$HOME" ? homedir()
  : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path.startsWith("$HOME/") ? join(homedir(), path.slice(6)) : path;

export type ProjectPermissionApprovals = {
  permissions?: readonly NativePermissionRule[];
  agents?: Readonly<Record<string, { permissions?: readonly NativePermissionRule[] }>>;
  default_agent?: string;
  projectPermissionApprovals?: readonly { action: string; resources: readonly string[] }[];
};

/** Product-owned Remember overrides Ask only. A native agent/session/firm Deny
 * and an effective project Deny remain authoritative. No Git identity enters. */
export function projectPermissionEffect(settings: ProjectPermissionApprovals, action: string, resources: readonly string[],
  nativeEffect: PermissionAction, agentID = settings.default_agent): PermissionAction {
  if (nativeEffect === "deny") return "deny";
  const rules = [...settings.permissions ?? [], ...(agentID ? settings.agents?.[agentID]?.permissions ?? [] : [])];
  const effects = resources.map(resource => {
    let effect: PermissionAction | undefined;
    for (const rule of rules) if (permissionPatternMatches(action, rule.action) && permissionPatternMatches(resource, home(rule.resource))) effect = rule.effect;
    return effect;
  });
  if (effects.includes("deny")) return "deny";
  const effect = effects.includes("ask") ? "ask" : nativeEffect;
  if (effect !== "ask" || !resources.length) return effect;
  const approvals = settings.projectPermissionApprovals ?? [];
  return resources.every(resource => approvals.some(approval => permissionPatternMatches(action, approval.action)
    && approval.resources.some(pattern => permissionPatternMatches(resource, home(pattern))))) ? "allow" : "ask";
}

/** Candidate native folder rules for project file UI and sandbox mounts. The
 * consumer still enforces whole-folder scoped Ask/Deny before mounting. These
 * are derived in memory; never write them into native project config files. */
export function rememberedProjectFolderRules(settings: ProjectPermissionApprovals, agentID = settings.default_agent): NativePermissionRule[] {
  const resources = [...new Set((settings.projectPermissionApprovals ?? []).flatMap(approval =>
    permissionPatternMatches("external_directory", approval.action) ? approval.resources : []))];
  return resources.filter(resource => projectPermissionEffect(settings, "external_directory", [resource], "ask", agentID) === "allow")
    .map(resource => ({ action: "external_directory", resource, effect: "allow" }));
}
