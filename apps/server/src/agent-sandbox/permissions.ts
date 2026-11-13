export type PermissionAction = "allow" | "ask" | "deny";

function isAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

export type NativePermissionRule = { action: string; resource: string; effect: PermissionAction };

/** Native ordered wildcard rules, including Windows path matching. */
export function permissionPatternMatches(input: string, pattern: string, windows = process.platform === "win32"): boolean {
  let expression = pattern.replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (expression.endsWith(" .*")) expression = expression.slice(0, -3) + "( .*)?";
  return new RegExp(`^${expression}$`, windows ? "si" : "s").test(input.replaceAll("\\", "/"));
}

/** Later matching entries win, as in the engine. Invalid policy fails closed. */
export function permissionAction(
  permissions: readonly NativePermissionRule[],
  tool: string,
  pattern: string,
  fallback: PermissionAction = "allow",
): PermissionAction {
  let action = fallback;
  if (!Array.isArray(permissions)) return "deny";
  const nativeTool = tool === "bash" ? "shell" : tool;
  for (const rule of permissions) {
    if (!rule || typeof rule.action !== "string" || typeof rule.resource !== "string" || !isAction(rule.effect)) return "deny";
    if (permissionPatternMatches(nativeTool, rule.action) && permissionPatternMatches(pattern, rule.resource)) action = rule.effect;
  }
  return action;
}
