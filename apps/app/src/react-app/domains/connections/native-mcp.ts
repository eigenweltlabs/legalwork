import { ensureNativeCatalogReady } from "@/app/lib/opencode-catalog-ready";
import { readConfig } from "@/app/lib/opencode-config";
import type { Client, McpServerEntry, McpStatusMap } from "@/app/types";
import type { ConnectorConfig } from "@legalwork/types/connector-config";
import { createLegalworkServerClient } from "@/app/lib/legalwork-server";
import { getClientContext, resolveLegalworkWorkspaceMount } from "@/app/lib/opencode";

/** MCP status is native catalog data; the map is only the app's presentation index. */
export async function readMcpStatuses(client: Client, directory?: string): Promise<McpStatusMap> {
  await ensureNativeCatalogReady(client, directory);
  const result = await client.mcp.list({ location: directory ? { directory } : undefined });
  return Object.fromEntries(result.data.map(server => [server.name, server.status]));
}

export async function removeMcpCredentials(client: Client, server: string, directory: string) {
  const location = { directory };
  const entry = (await client.mcp.list({ location })).data.find(item => item.name === server);
  await client.mcp.disconnect({ location, server });
  if (!entry?.integrationID) return;
  const credentials = await client.credential.list();
  for (const credential of credentials.filter(item => item.integrationID === entry.integrationID && item.active)) {
    await client.credential.remove({ credentialID: credential.id });
  }
}

/** Definitions are read for display; their persistence belongs to LegalWork settings. */
export async function readConfiguredMcpServers(client: Client, directory: string): Promise<McpServerEntry[]> {
  const context = getClientContext(client), mount = context && resolveLegalworkWorkspaceMount(context.baseUrl);
  if (mount && context.auth?.mode === "legalwork") {
    const server = createLegalworkServerClient({ baseUrl: mount.baseUrl, token: context.auth.token ?? "", hostToken: context.auth.hostToken });
    return (await server.listMcp(mount.workspaceId)).items;
  }
  await ensureNativeCatalogReady(client, directory);
  const [config, catalog] = await Promise.all([readConfig(client, directory), client.mcp.list({ location: { directory } })]);
  return catalog.data.map(server => {
    const definition = config.mcp?.servers?.[server.name];
    const common = { enabled: server.status.status !== "disabled", ...(definition?.timeout?.execution === undefined ? {} : { timeout: definition.timeout.execution }) };
    const entry: ConnectorConfig = definition?.type === "local"
      ? { ...common, type: "local", command: [...definition.command], cwd: definition.cwd, environment: definition.environment }
      : { ...common, type: "remote", ...(definition?.type === "remote" ? { url: definition.url, headers: definition.headers,
          ...(definition.oauth === false ? { oauth: false } : definition.oauth ? { oauth: { clientId: definition.oauth.client_id, clientSecret: definition.oauth.client_secret, scope: definition.oauth.scope, callbackPort: definition.oauth.callback_port, redirectUri: definition.oauth.redirect_uri } } : {}) } : {}) };
    return { name: server.name, config: entry };
  });
}
