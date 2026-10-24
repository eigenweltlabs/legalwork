import { randomUUID } from "node:crypto";
import { z } from "zod";
import { connectorConnectionSchema, connectorOAuthClientInputSchema, connectorOAuthClientSchema, type ConnectorOAuthClientInput } from "./schema.js";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { StorageOAuth } from "../file-storage/oauth/session.js";
import { OAuthVault, oauthVaultPath, vaultLock } from "../file-storage/oauth/vault.js";
import { connectionProvider } from "./definition.js";
import { clearConnectorActivation, connectorOAuthWriteIds } from "./settings.js";
import { connectorDefinition } from "./definition.js";
import { connectorOAuthProvider, defaultConnectorOAuthClient } from "./oauth-providers.js";
import { requireConnectorConnectSlot } from "./single-connection.js";

const stateSchema = z.object({
  client: connectorOAuthClientInputSchema,
  builtIn: z.boolean().optional(),
  revision: z.string(),
  connections: z.array(connectorConnectionSchema.extend({ readOnly: z.boolean(), authorizedWrites: z.array(z.string()).optional(), authorizedSends: z.boolean().optional(), grantKey: z.string().optional() })),
});
type LocalState = z.infer<typeof stateSchema>;
type LocalFlow = { id: string; connectionId: string; key: string; revision: string; expiresAt: number; reconnect: boolean; activated: boolean; readOnly: boolean; authorizedWrites: string[] };
const sessions = new WeakMap<ServerConfig, StorageOAuth>();
const activeFlows = new WeakMap<ServerConfig, Map<string, LocalFlow>>();
function session(config: ServerConfig) {
  let oauth = sessions.get(config);
  if (!oauth) { oauth = new StorageOAuth(oauthVaultPath(config)); sessions.set(config, oauth); }
  return oauth;
}
const stateKey = (id: string) => JSON.stringify(["connector-oauth-app", connectionProvider(id)]);
const legacyGrantKey = (id: string, revision: string, connectionId: string, readOnly: boolean) => JSON.stringify(["connector-oauth-grant", connectionProvider(id), revision, connectionId, readOnly]);
function grantKey(id: string, revision: string, connection: LocalState["connections"][number]) {
  return connection.grantKey ?? legacyGrantKey(id, revision, connection.id, connection.readOnly);
}
function authorizedWrites(id: string, connection: LocalState["connections"][number]) {
  if (connection.authorizedWrites) return connection.authorizedWrites;
  // Before scoped write settings, mail/calendar grants requested writes;
  // storage grants requested only read scopes on every server.
  if (connection.readOnly || connectorDefinition(id).kind === "files") return [];
  return connectionProvider(id) === "outlook" ? ["outlook", "outlook-calendar"] : [id];
}
function state(config: ServerConfig, id: string) { return session(config).vault.getEntry(stateKey(id), stateSchema); }
function mutate<T>(config: ServerConfig, id: string, update: (current: LocalState | undefined, vault: OAuthVault) => Promise<T>) {
  return vaultLock(`${oauthVaultPath(config)}:${stateKey(id)}`, async () => update(await state(config, id), session(config).vault));
}
async function cancelPending(config: ServerConfig, id: string) {
  const flows = activeFlows.get(config);
  if (!flows) return;
  const current = await state(config, id);
  for (const [key, flow] of flows) if (connectionProvider(flow.id) === connectionProvider(id) && flow.revision !== current?.revision) {
    flows.delete(key); session(config).cancel(flow.key);
    if (!flow.activated) await session(config).disconnect(flow.key);
  }
}

export async function localOAuthClient(config: ServerConfig, id: string) {
  const saved = await state(config, id);
  const defaultClient = defaultConnectorOAuthClient(id);
  const client = saved?.client ?? defaultClient ?? { clientId: "", tenantId: "" };
  const writeIds = await connectorOAuthWriteIds(config, id);
  const provider = connectorOAuthProvider(id, client, writeIds);
  return connectorOAuthClientSchema.parse({ configured: Boolean(saved || defaultClient), builtIn: saved ? saved.builtIn === true : Boolean(defaultClient), clientId: client.clientId, tenantId: client.tenantId,
    hasClientSecret: Boolean(client.clientSecret), supportsClientSecret: provider.supportsClientSecret,
    family: provider.family, redirectUri: provider.redirectUri, scopes: provider.application.scopes(writeIds.length === 0) });
}

export async function saveLocalOAuthClient(config: ServerConfig, id: string, input: ConnectorOAuthClientInput) {
  const parsed = connectorOAuthClientInputSchema.parse(input);
  await session(config).vault.ready();
  const previous = await mutate(config, id, async (current, vault) => {
    const client = { ...parsed, clientSecret: parsed.clientSecret ?? (current?.client.clientId === parsed.clientId ? current.client.clientSecret : undefined) };
    connectorOAuthProvider(id, client, await connectorOAuthWriteIds(config, id));
    await vault.setEntry(stateKey(id), stateSchema, { client, revision: randomUUID(), connections: current?.connections.map((item) => ({ ...item, needsReconnect: true })) ?? [] });
    return current;
  });
  await cancelPending(config, id);
  if (previous) await Promise.all(previous.connections.map((connection) => session(config).disconnect(grantKey(id, previous.revision, connection))));
  return localOAuthClient(config, id);
}

export async function removeLocalOAuthClient(config: ServerConfig, id: string) {
  const previous = await mutate(config, id, async (current, vault) => { await vault.setEntry(stateKey(id), stateSchema); return current; });
  await cancelPending(config, id);
  if (previous) await Promise.all(previous.connections.map(async (connection) => {
    await session(config).disconnect(grantKey(id, previous.revision, connection));
    await clearConnectorActivation(config, id, connection.id);
  }));
  return localOAuthClient(config, id);
}

export async function localOAuthConnections(config: ServerConfig, id: string) {
  const saved = await state(config, id);
  if (!saved) return [];
  return Promise.all(saved.connections.map(async (connection) => connectorConnectionSchema.parse({ ...connection, source: "custom",
    needsReconnect: connection.needsReconnect || !(await session(config).vault.get(grantKey(id, saved.revision, connection))),
  })));
}

export async function localOAuthAccessToken(config: ServerConfig, id: string, connectionId: string, forceRefresh: boolean) {
  const saved = await state(config, id);
  const connection = saved?.connections.find((item) => item.id === connectionId);
  if (!saved || !connection) return undefined;
  if (connection.needsReconnect) throw new ApiError(409, "connector_reconnect_required", "Reconnect this account in Integrations to restore access.");
  try {
    const token = await session(config).access(grantKey(id, saved.revision, connection), connectorOAuthProvider(id, saved.client, authorizedWrites(id, connection)).application, forceRefresh);
    const current = await state(config, id);
    if (current?.revision !== saved.revision || !current.connections.some((item) => item.id === connectionId && !item.needsReconnect && grantKey(id, current.revision, item) === grantKey(id, saved.revision, connection))) {
      throw new ApiError(409, "connector_not_connected", "Connect this account in Integrations before using it.");
    }
    return token;
  } catch (error) {
    if (error instanceof ApiError && error.code === "storage_signin_required") {
      await mutate(config, id, async (current, vault) => {
        if (!current || current.revision !== saved.revision) return;
        await vault.setEntry(stateKey(id), stateSchema, { ...current, connections: current.connections.map((item) => item.id === connectionId && grantKey(id, current.revision, item) === grantKey(id, saved.revision, connection) ? { ...item, needsReconnect: true } : item) });
      });
      throw new ApiError(409, "connector_reconnect_required", "Reconnect this account in Integrations to restore access.");
    }
    throw error;
  }
}

export async function disconnectLocalOAuth(config: ServerConfig, id: string, connectionId: string) {
  const removed = await mutate(config, id, async (current, vault) => {
    const connection = current?.connections.find((item) => item.id === connectionId);
    if (!current || !connection) return undefined;
    await vault.setEntry(stateKey(id), stateSchema, { ...current, connections: current.connections.filter((item) => item.id !== connectionId) });
    return { revision: current.revision, connection };
  });
  if (!removed) return false;
  const pending = activeFlows.get(config);
  if (pending) for (const [key, flow] of pending) if (connectionProvider(flow.id) === connectionProvider(id) && flow.connectionId === connectionId) {
    pending.delete(key); session(config).cancel(flow.key);
    if (!flow.activated) await session(config).disconnect(flow.key);
  }
  await session(config).disconnect(grantKey(id, removed.revision, removed.connection));
  return true;
}

export async function requireLocalOAuthSendAccess(config: ServerConfig, id: string, connectionId: string) {
  const saved = await state(config, id);
  const connection = saved?.connections.find((item) => item.id === connectionId);
  if (connection && (id === "outlook" ? connection.authorizedSends !== true : !authorizedWrites(id, connection).includes(id))) {
    throw new ApiError(409, "connector_write_reconnect_required", "Reconnect this email account with write access enabled to grant sending permission.");
  }
}

export function createLocalOAuthFlows(config: ServerConfig) {
  const flows = activeFlows.get(config) ?? new Map<string, LocalFlow>();
  activeFlows.set(config, flows);
  const cancel = async (flowId: string) => {
    const flow = flows.get(flowId);
    if (flow) {
      flows.delete(flowId); session(config).cancel(flow.key);
      if (!flow.activated) await session(config).disconnect(flow.key);
    }
    return { ok: true };
  };
  return {
    async start(id: string, connectionId?: string) {
      await session(config).vault.ready();
      for (const [key, flow] of flows) if (Date.now() >= flow.expiresAt) await cancel(key);
      if (flows.size >= 20) throw new ApiError(429, "connector_too_many_flows", "Finish or cancel an existing connection before starting another.");
      const saved = await mutate(config, id, async (current, vault) => {
        if (current) return current;
        const client = defaultConnectorOAuthClient(id);
        if (!client) throw new ApiError(409, "connector_oauth_client_required", "Enter and save your OAuth app details before connecting.");
        const initial = stateSchema.parse({ client, builtIn: true, revision: randomUUID(), connections: [] });
        await vault.setEntry(stateKey(id), stateSchema, initial);
        return initial;
      });
      requireConnectorConnectSlot(saved.connections, connectionId, "custom");
      if (connectionId && !saved.connections.some((item) => item.id === connectionId)) throw new ApiError(404, "connector_connection_not_found", "Connection not found.");
      const handle = connectionId ?? randomUUID();
      const flowId = `local-${randomUUID()}`;
      const writeIds = await connectorOAuthWriteIds(config, id);
      const readOnly = writeIds.length === 0;
      const key = JSON.stringify(["connector-oauth-pending-grant", connectionProvider(id), saved.revision, handle, flowId]);
      for (const [previousId, previous] of flows) if (connectionProvider(previous.id) === connectionProvider(id) && previous.connectionId === handle) await cancel(previousId);
      const flow = { id, connectionId: handle, key, revision: saved.revision, expiresAt: Date.now() + 5 * 60_000, reconnect: Boolean(connectionId), activated: false, readOnly, authorizedWrites: writeIds };
      flows.set(flowId, flow);
      try {
        const result = await session(config).startProvider(key, connectorOAuthProvider(id, saved.client, writeIds).application, readOnly, async () => {
          const current = await state(config, id);
          return flows.get(flowId) === flow && current?.revision === saved.revision && (!flow.reconnect || current.connections.some((item) => item.id === handle));
        });
        return { flowId, connectUrl: result.authUrl, expiresAt: result.expiresAt };
      } catch (error) { flows.delete(flowId); throw error; }
    },
    async status(flowId: string) {
      const flow = flows.get(flowId);
      if (!flow) throw new ApiError(404, "connector_flow_not_found", "Connection flow not found. Start again.");
      if (Date.now() >= flow.expiresAt) { await cancel(flowId); return { status: "expired", connection: null }; }
      const oauth = await session(config).status(flow.key);
      if (oauth.error) {
        const saved = await state(config, flow.id);
        throw new ApiError(409, "connector_oauth_failed", saved?.builtIn
          ? "Microsoft sign-in did not complete. Try again, or ask your Microsoft administrator whether approval is required."
          : "Sign-in did not complete. Check your OAuth app details and try again.");
      }
      if (!oauth.connected || oauth.pending) return { status: "pending", connection: null };
      const activated = await mutate(config, flow.id, async (current, vault) => {
        if (flows.get(flowId) !== flow || !current || current.revision !== flow.revision || (flow.reconnect && !current.connections.some((item) => item.id === flow.connectionId))) {
          throw new ApiError(409, "connector_state_changed", "Your connected accounts changed. Start again.");
        }
        const previous = current.connections.find((item) => item.id === flow.connectionId);
        requireConnectorConnectSlot(current.connections, flow.reconnect || flow.activated ? flow.connectionId : undefined, "custom");
        const connection = { id: flow.connectionId, createdAt: current.connections.find((item) => item.id === flow.connectionId)?.createdAt ?? new Date().toISOString(), needsReconnect: false, source: "custom", readOnly: flow.readOnly, authorizedWrites: flow.authorizedWrites, authorizedSends: flow.authorizedWrites.includes("outlook"), grantKey: flow.key };
        if (!await vault.setEntry(stateKey(flow.id), stateSchema, { ...current, connections: [...current.connections.filter((item) => item.id !== flow.connectionId), connection] }, () => flows.get(flowId) === flow)) {
          throw new ApiError(409, "connector_state_changed", "Your connected accounts changed. Start again.");
        }
        flow.activated = true;
        return { connection: connectorConnectionSchema.parse(connection), obsoleteKey: previous && grantKey(flow.id, current.revision, previous) !== flow.key ? grantKey(flow.id, current.revision, previous) : undefined };
      });
      if (activated.obsoleteKey) await session(config).disconnect(activated.obsoleteKey);
      return { status: "connected", connection: activated.connection };
    },
    cancel,
  };
}

/** Legacy storage grants requested only read scopes even on writable servers. */
export async function requireLocalOAuthWriteAccess(config: ServerConfig, id: string, connectionId: string) {
  const saved = await state(config, id);
  const connection = saved?.connections.find((item) => item.id === connectionId);
  if (!connection || connection.needsReconnect) throw new ApiError(409, "connector_reconnect_required", "Reconnect this account in Integrations to restore access.");
  if (!authorizedWrites(id, connection).includes(id)) throw new ApiError(409, "connector_write_reconnect_required", "This account has not granted write permissions for this connector. Enable its write access, then reconnect the account to grant the required permissions. Reading remains available.");
}
