/** Refresh workspace bindings on every engine instance build. A single shared
 * bootstrap file cannot carry a different gateway credential for each folder. */
export const LegalWorkMcpGateway = async (input: { directory?: string }) => {
  const baseUrl = process.env.LEGALWORK_SERVER_URL;
  const token = process.env.LEGALWORK_CONNECTOR_TOKEN;
  if (!baseUrl || !token || !input.directory) return {};
  const url = new URL("/internal/mcp/config", baseUrl);
  url.searchParams.set("directory", input.directory);
  return {
    async config(config: { mcp?: Record<string, unknown> }) {
      const local = Object.fromEntries(Object.entries(config.mcp ?? {}).filter(([, value]) => isRecord(value) && value.type === "local"));
      // Fail closed for remote connectors while preserving ordinary local tools.
      config.mcp = local;
      const response = await fetch(url, { headers: { "x-legalwork-connector-token": token }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!response?.ok) return;
      const body: unknown = await response.json();
      if (!isRecord(body) || !isRecord(body.mcp) || !Array.isArray(body.managedNames)) return;
      for (const name of body.managedNames) if (typeof name === "string") delete local[name];
      const entries: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(body.mcp)) if (isRecord(entry)) entries[name] = entry;
      config.mcp = { ...local, ...entries };
    },
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
