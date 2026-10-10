export const managedTools: Record<string, string> = { bash: "legalwork_shell", webfetch: "legalwork_webfetch", websearch: "legalwork_websearch" };

// Distinguishes generated network denials from restrictions saved by older chats.
export const managedNetworkGuard = "legalwork_managed_network_guard";
export function managedToolName(name: string): string {
  return Object.hasOwn(managedTools, name) ? managedTools[name] : name;
}
export function managedPermissionRules<T extends { permission: string; pattern: string; action: string }>(agent: T[], session: T[]) {
  const guarded = session.some(rule => rule.permission === managedNetworkGuard && rule.pattern === "*" && rule.action === "deny");
  return [...agent.filter(rule => !Object.hasOwn(managedTools, rule.permission)),
    ...session.filter(rule => rule.permission !== "bash" && rule.permission !== managedNetworkGuard && !(guarded && Object.hasOwn(managedTools, rule.permission)))]
    .map(rule => ({ ...rule, permission: Object.entries(managedTools).find(([, managed]) => managed === rule.permission)?.[0] ?? rule.permission }));
}

/** Keep built-in host execution disabled even when a sandbox plugin cannot load. */
export function sandboxEnginePermissions(input: Record<string, unknown> = {}): Record<string, unknown> {
  const result = { ...input };
  for (const [builtin, managed] of Object.entries(managedTools)) {
    delete result[builtin];
    if (input[builtin] !== undefined) result[managed] = input[builtin];
    result[builtin] = "deny";
  }
  return result;
}

export function sandboxEngineAgents(agents: Record<string, Record<string, unknown>>) {
  const result: Record<string, Record<string, unknown>> = {};
  for (const name of new Set(["build", "plan", "general", "explore", "compaction", "title", "summary", ...Object.keys(agents)])) {
    const agent = agents[name] ?? {};
    const permissions = agent.permission;
    result[name] = { ...agent, permission: sandboxEnginePermissions(
      permissions && typeof permissions === "object" && !Array.isArray(permissions) ? Object.fromEntries(Object.entries(permissions)) : {},
    ) };
  }
  return result;
}
