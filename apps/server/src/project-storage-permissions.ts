import { isAbsolute, relative, resolve, sep } from "node:path";
import { permissionPatternMatches } from "./agent-sandbox/permissions.js";

/** Native path permissions used to be relative to the document folder. Keep
 * their local meaning and also evaluate them against connected documents. */
export function projectFilePermissionRules<T extends { action: string; resource: string }>(workspace: {path: string; contentPath?: string | null; previousPath?: string | null}, rules: readonly T[]): T[] {
  if (!workspace.contentPath) return [...rules];
  const contentPath = workspace.contentPath;
  return rules.flatMap(rule => {
    const actions = ["read", "edit", "list", "external_directory"].filter(action => permissionPatternMatches(action, rule.action));
    if (rule.resource === "*" || !actions.length) return [rule];
    const suffix = isAbsolute(rule.resource) && workspace.previousPath ? relative(workspace.previousPath, rule.resource) : rule.resource;
    const moved = /^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix);
    const resource = moved ? resolve(workspace.path, suffix) : isAbsolute(rule.resource) ? rule.resource : resolve(contentPath, rule.resource);
    // A generic rule can also describe a command. Its translated aliases must
    // apply only to filesystem actions, preserving the original shell policy.
    return resource === rule.resource ? [rule] : [rule, ...actions.map(action => ({ ...rule, action, resource: resource.replaceAll("\\", "/") }))];
  });
}

/** The connected document root replaces the location's former implicit access.
 * Put it before explicit rules so narrower Deny/Ask statements stay authoritative. */
export function primaryContentFolderRules(workspace: { path: string; contentPath?: string | null }): Array<{ action: string; resource: string; effect: "allow" }> {
  if (!workspace.contentPath) return [];
  const suffix = relative(resolve(workspace.path), resolve(workspace.contentPath));
  if (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)) return [];
  return [{ action: "external_directory", resource: `${workspace.contentPath.replaceAll("\\", "/").replace(/\/$/, "")}/*`, effect: "allow" }];
}
