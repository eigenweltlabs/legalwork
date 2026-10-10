export type PermissionAction = "allow" | "ask" | "deny";

function isAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

/** OpenCode 1.18's ordered wildcard rules, including Windows path matching. */
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
  permissions: Record<string, unknown>,
  tool: string,
  pattern: string,
  fallback: PermissionAction = "allow",
): PermissionAction {
  let action = fallback;
  for (const [name, rule] of Object.entries(permissions)) {
    if (!permissionPatternMatches(tool, name)) continue;
    if (isAction(rule)) {
      action = rule;
      continue;
    }
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "deny";
    for (const [match, value] of Object.entries(rule)) {
      if (!isAction(value)) return "deny";
      if (permissionPatternMatches(pattern, match)) action = value;
    }
  }
  return action;
}
