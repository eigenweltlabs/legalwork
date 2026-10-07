/** Keep the host shell disabled even when a sandbox plugin cannot load. */
export function sandboxEnginePermissions(input: Record<string, unknown> = {}): Record<string, unknown> {
  const result = { ...input };
  const shell = input.bash;
  delete result.bash;
  // The separate tool name is intentional: it must never fall back to the
  // engine's built-in host bash implementation.
  if (shell !== undefined) result.legalwork_shell = shell;
  result.bash = "deny";
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
