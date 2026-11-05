import { permissionAction, type NativePermissionRule } from "./permissions.js";
import type { NativeRuntimeConfiguration } from "../runtime-config-upgrade.js";

export const managedTools: Record<string, string> = { bash: "legalwork_shell", webfetch: "legalwork_webfetch", websearch: "legalwork_websearch" };
export const nativeHostExecutionActions = ["shell", "bash", "webfetch", "websearch", "codesearch"];

// Distinguishes generated network denials from restrictions saved by older chats.
export const managedNetworkGuard = "legalwork_managed_network_guard";
export function managedToolName(name: string): string {
  return Object.hasOwn(managedTools, name) ? managedTools[name] : name;
}
export function managedPermissionRules<T extends { permission: string; pattern: string; action: string }>(agent: T[], session: T[]) {
  const guarded = session.some(rule => rule.permission === managedNetworkGuard && rule.pattern === "*" && rule.action === "deny");
  return [...agent.filter(rule => !Object.hasOwn(managedTools, rule.permission)
      || !agent.some(other => other.permission === managedTools[rule.permission])),
    ...session.filter(rule => rule.permission !== managedNetworkGuard && !(guarded && Object.hasOwn(managedTools, rule.permission) && rule.pattern === "*" && rule.action === "deny"))]
    .map(rule => ({ ...rule, permission: Object.entries(managedTools).find(([, managed]) => managed === rule.permission)?.[0] ?? rule.permission }));
}

/** The engine adds file-reader defaults even when command approvals are off.
 * Applying those defaults to an entire shell command asks for every project
 * read, and classifies every host command as external-directory access.
 * Keep explicit user, agent and firm rules. Native file tools retain their
 * own per-path checks; the managed shell uses its configured permission. */
export function explicitFileApprovals<T extends { permission: string; pattern: string; action: string }>(agent: T[], configured: readonly NativePermissionRule[]) {
  return agent.filter(rule => {
    const implicit = rule.action === "ask" && (
      rule.permission === "external_directory" && rule.pattern === "*" ||
      rule.permission === "read" && ["*.env", "*.env.*"].includes(rule.pattern)
    );
    if (!implicit) return true;
    return permissionAction(configured, rule.permission, rule.pattern) !== "allow";
  });
}

/** Keep built-in host execution disabled even when a sandbox plugin cannot load. */
export function sandboxEnginePermissions(input: readonly NativePermissionRule[] = []): NativePermissionRule[] {
  const managed: Record<string, string> = { shell: "legalwork_shell", webfetch: "legalwork_webfetch", websearch: "legalwork_websearch" };
  return [...input.map(rule => ({ ...rule, action: managed[rule.action] ?? rule.action })),
    ...Object.keys(managed).map((action): NativePermissionRule => ({ action, resource: "*", effect: "deny" }))];
}

export function sandboxEngineAgents(agents: NonNullable<NativeRuntimeConfiguration["agents"]>) {
  const result: Record<string, NonNullable<NativeRuntimeConfiguration["agents"]>[string]> = {};
  for (const name of new Set(["build", "plan", "general", "explore", "compaction", "title", "summary", ...Object.keys(agents)])) {
    const agent = agents[name] ?? {};
    result[name] = { ...agent, permissions: sandboxEnginePermissions(agent.permissions ?? []) };
  }
  return result;
}
