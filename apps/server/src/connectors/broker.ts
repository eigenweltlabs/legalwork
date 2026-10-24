import { randomUUID } from "node:crypto";
import { oauthVaultPath } from "../file-storage/oauth/vault.js";
import { z } from "zod";
import {
  connectorConnectionSchema, connectorDefinitions, connectorTokenSchema, type ConnectorConnection,
} from "./schema.js";
import { ApiError } from "../errors.js";
import { eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import type { ServerConfig } from "../types.js";
import { connectorVault, readConnectorConnections, readConnectorState, writeConnectorConnections, type StoredConnectorConnection } from "./store.js";
import { createNangoAuthFlow } from "./auth-flow.js";
import { connectorDefinition, connectionProvider } from "./definition.js";
import { createLocalOAuthFlows, disconnectLocalOAuth, localOAuthAccessToken, localOAuthClient, localOAuthConnections } from "./local-oauth.js";
import { requireConnectorConnectSlot, reserveConnectorConnectSlot, withConnectorConnectLock } from "./single-connection.js";
import { clearConnectorActivation, connectorIsActivated, recordConnectorActivation, requireConnectorActivated } from "./settings.js";
import { defaultConnectorOAuthClient } from "./oauth-providers.js";
export { connectorDefinition } from "./definition.js";

const statusSchema = z.object({ connection: connectorConnectionSchema });
const sessionSchema = z.object({ sessionToken: z.string().min(1), integrationId: z.string().min(1), expiresAt: z.number().finite() });
const catalogSchema = z.object({ configured: z.boolean(), providers: z.array(z.object({ id: z.string() })) });

function ownerKey(account: { orgId: string; userId: string }) {
  return JSON.stringify([eigenweltPlatformUrl(), account.orgId, account.userId]);
}

async function brokerIdentity(config: ServerConfig) {
  const token = await ensureFreshPlatformToken(config);
  const connection = await readEigenweltConnection(config);
  if (!token || !connection.account) throw new ApiError(403, "connector_signin_required", "Sign in with Eigenwelt to connect an account.");
  return { token, owner: ownerKey(connection.account) };
}

async function brokerRequest(config: ServerConfig, method: string, path: string, body?: unknown, expectedOwner?: string): Promise<unknown> {
  const identity = await brokerIdentity(config);
  if (expectedOwner && identity.owner !== expectedOwner) throw new ApiError(409, "connector_account_changed", "Your Eigenwelt account changed. Start again.");
  const request = async (token: string) => {
    try {
      return await fetch(`${eigenweltPlatformUrl()}/api/connectors${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(35_000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(502, "connector_broker_unreachable", "Could not reach the account connection service. Try again shortly.");
    }
  };
  let response = await request(identity.token);
  if (response.status === 401) {
    await ensureFreshPlatformToken(config, { force: true });
    const refreshed = await brokerIdentity(config);
    if (refreshed.owner !== identity.owner) throw new ApiError(409, "connector_account_changed", "Your Eigenwelt account changed. Start again.");
    response = await request(refreshed.token);
  }
  if (!response.ok) {
    const codes: Record<number, [string, string]> = {
      401: ["connector_signin_required", "Sign in with Eigenwelt again to connect an account."],
      403: ["connector_access_denied", "Your Eigenwelt account cannot access this connection."],
      404: ["connector_connection_not_found", "Connection not found. Connect the account again."],
      409: ["connector_reconnect_required", "Reconnect this account to restore access."],
      429: ["connector_rate_limited", "Too many connection requests. Try again shortly."],
      503: ["connectors_not_configured", "Account connections are not available yet. Try again later."],
    };
    const [code, message] = codes[response.status] ?? ["connector_broker_failed", "The account connection service could not complete this request."];
    throw new ApiError(response.status >= 500 ? 502 : response.status, code, message);
  }
  try { return await response.json(); }
  catch { throw new ApiError(502, "connector_broker_invalid", "The account connection service returned an invalid response."); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(502, "connector_broker_invalid", "The account connection service returned an invalid response.");
  return result.data;
}

async function checkConnection(config: ServerConfig, owner: string, id: string, connection: StoredConnectorConnection) {
  try {
    const status = parse(statusSchema, await brokerRequest(config, "POST", `/${encodeURIComponent(id)}/connection/status`, { connectionId: connection.nangoConnectionId }, owner)).connection;
    if (status.id !== connection.nangoConnectionId) throw new ApiError(502, "connector_broker_invalid", "The connection service returned an invalid account.");
    return { ...connection, createdAt: status.createdAt, needsReconnect: status.needsReconnect };
  } catch (error) {
    if (error instanceof ApiError && error.code === "connector_connection_not_found") return null;
    if (error instanceof ApiError && error.code === "connector_reconnect_required") return { ...connection, needsReconnect: true };
    throw error;
  }
}

// Only status metadata is cached. Credential retrieval still verifies current
// ownership for every request. Share checks across modals, workspaces and the
// two Outlook connectors, with saved state in the key to invalidate changes.
const statusChecks = new Map<string, { until: number; result: Promise<StoredConnectorConnection | null> }>();
const STATUS_CACHE_MS = 30_000;

async function refreshConnection(config: ServerConfig, owner: string, id: string, connection: StoredConnectorConnection, forceRefresh = false) {
  if (connection.needsReconnect) return connection;
  const key = JSON.stringify([oauthVaultPath(config), owner, connectionProvider(id), connection]);
  let entry = statusChecks.get(key);
  if (!entry || (entry.until !== 0 && (forceRefresh || entry.until <= Date.now()))) {
    if (statusChecks.size >= 256) {
      const oldest = statusChecks.keys().next().value;
      if (oldest !== undefined) statusChecks.delete(oldest);
    }
    const next = { until: 0, result: checkConnection(config, owner, id, connection) };
    statusChecks.set(key, next);
    next.result.then(() => { next.until = Date.now() + STATUS_CACHE_MS; }, () => { if (statusChecks.get(key) === next) statusChecks.delete(key); });
    entry = next;
  }
  const value = await entry.result;
  return value ? { ...value } : null;
}

export async function listConnectorConnections(config: ServerConfig, id: string, forceRefresh = false) {
  connectorDefinition(id);
  const local = await localOAuthConnections(config, id);
  const platform = await readEigenweltConnection(config);
  const account = platform.account;
  if (!account || (!platform.platformToken && !platform.refreshToken)) return local;
  const owner = ownerKey(account);
  const provider = connectionProvider(id);
  const savedState = await readConnectorState(config, owner, provider);
  let connections = savedState.connections;
  if (connections.some((connection) => !connection.needsReconnect)) {
    const refreshed = await Promise.all(connections.map((connection) => refreshConnection(config, owner, id, connection, forceRefresh)));
    connections = refreshed.filter((connection) => connection !== null);
    if (savedState.snapshot !== null && !await writeConnectorConnections(config, owner, provider, connections, savedState.snapshot)) {
      connections = await readConnectorConnections(config, owner, provider);
    }
  }
  return [...connections.map((connection) => connectorConnectionSchema.parse(connection)), ...local];
}

/** Admission checks read only saved metadata; they never discover accounts remotely. */
export async function savedConnectorConnections(config: ServerConfig, id: string) {
  const local = await localOAuthConnections(config, id);
  const platform = await readEigenweltConnection(config);
  if (!platform.account || (!platform.platformToken && !platform.refreshToken)) return local;
  const managed = await readConnectorConnections(config, ownerKey(platform.account), connectionProvider(id));
  return [...managed.map((connection) => connectorConnectionSchema.parse(connection)), ...local];
}
/** Only the explicit owner-only team-promotion route may export this capability
 * to the platform. It is never returned to the renderer or agent tools. */
export async function managedStorageCapability(config: ServerConfig, id: string, accountId: string) {
  if (connectorDefinition(id).kind !== "files") throw new ApiError(400, "invalid_payload", "Choose a storage account.");
  const { owner } = await brokerIdentity(config);
  const saved = await readConnectorConnections(config, owner, connectionProvider(id));
  const account = saved.find((entry) => entry.id === accountId && !entry.needsReconnect);
  if (!account || saved.length !== 1) throw new ApiError(409, "storage_managed_required", "Shared team accounts require a single account connected with Eigenwelt. Own-app accounts can use individual member sign-in.");
  return account.nangoConnectionId;
}

/** Settings and Memory Drive use local metadata; only explicit refresh/access contacts the broker. */
export async function savedConnectorStatus(config: ServerConfig, connectorId?: string) {
  const definitions = connectorId ? [connectorDefinition(connectorId)] : connectorDefinitions;
  const platform = await readEigenweltConnection(config);
  const signedIn = Boolean(platform.account && (platform.platformToken || platform.refreshToken));
  return { configured: signedIn, requiresSignIn: !signedIn,
    connectors: await Promise.all(definitions.map(async ({ id, name }) => {
      const connections = await savedConnectorConnections(config, id);
      return { id, name, configured: signedIn, customConfigured: (await localOAuthClient(config, id)).configured,
        connections, active: await connectorActiveStatus(config, id, connections) };
    })),
  };
}

export async function connectorStatus(config: ServerConfig, connectorId?: string, forceRefresh = false) {
  const definitions = connectorId ? [connectorDefinition(connectorId)] : connectorDefinitions;
  if (definitions.every(({ id }) => defaultConnectorOAuthClient(id))) {
    const saved = await savedConnectorStatus(config, connectorId);
    if (saved.connectors.every(({ connections }) => connections.every(({ source }) => source === "custom"))) return saved;
  }
  const connection = await readEigenweltConnection(config);
  if ((!connection.platformToken && !connection.refreshToken) || !connection.account) {
    const connectors = await Promise.all(definitions.map(async ({ id, name }) => {
      const customConfigured = (await localOAuthClient(config, id)).configured;
      const connections = await localOAuthConnections(config, id);
      return { id, name, configured: false, customConfigured, connections, active: await connectorActiveStatus(config, id, connections) };
    }));
    return { configured: false, requiresSignIn: true, connectors };
  }
  // This platform catalog is local configuration, with no Nango request.
  const catalog = parse(catalogSchema, await brokerRequest(config, "GET", ""));
  const lists = new Map<string, ReturnType<typeof listConnectorConnections>>();
  return { configured: catalog.configured, requiresSignIn: false,
    connectors: await Promise.all(definitions.map(async ({ id, name }) => {
      const configured = catalog.configured && catalog.providers.some((provider) => provider.id === id);
      const provider = connectionProvider(id);
      let list = lists.get(provider);
      if (configured && !list) { list = listConnectorConnections(config, id, forceRefresh); lists.set(provider, list); }
      const customConfigured = (await localOAuthClient(config, id)).configured;
      const connections = list ? await list : await localOAuthConnections(config, id);
      return { id, name, configured, customConfigured, connections, active: await connectorActiveStatus(config, id, connections) };
    })),
  };
}

async function connectorActiveStatus(config: ServerConfig, id: string, connections: ConnectorConnection[]) {
  return connections.length === 1 && await connectorIsActivated(config, id, connections[0].id);
}

export async function setConnectorActivation(config: ServerConfig, id: string, connectionId: string, active: boolean) {
  if (id !== "outlook" && id !== "outlook-calendar") throw new ApiError(400, "connector_activation_unavailable", "This connector does not share an account with another connector.");
  return withConnectorConnectLock(config, id, async () => {
    requireConnectorConnectSlot(await savedConnectorConnections(config, id), connectionId);
    await recordConnectorActivation(config, id, connectionId, active);
    return { active: await connectorIsActivated(config, id, connectionId) };
  });
}

// Tokens never reach settings, logs or tool results. Custom OAuth grants use
// the local vault; Nango access tokens are held only in process memory.
export async function connectorAccessToken(config: ServerConfig, id: string, connectionId: string, forceRefresh = false) {
  connectorDefinition(id);
  await requireConnectorActivated(config, id, connectionId);
  const localToken = await localOAuthAccessToken(config, id, connectionId, forceRefresh);
  if (localToken) return localToken;
  const account = (await readEigenweltConnection(config)).account;
  if (!account) throw new ApiError(403, "connector_signin_required", "Sign in with Eigenwelt to connect an account.");
  const owner = ownerKey(account);
  const saved = await readConnectorConnections(config, owner, connectionProvider(id));
  const connection = saved.find((connection) => connection.id === connectionId && !connection.needsReconnect);
  if (!connection) throw new ApiError(409, "connector_not_connected", "Connect this account in Integrations before using it.");
  return parse(connectorTokenSchema, await brokerRequest(config, "POST",
    `/${encodeURIComponent(id)}/connection/token`, { connectionId: connection.nangoConnectionId, forceRefresh }, owner)).accessToken;
}

export async function disconnectConnector(config: ServerConfig, id: string, connectionId: string) {
  connectorDefinition(id);
  if (await disconnectLocalOAuth(config, id, connectionId)) {
    await clearConnectorActivation(config, id, connectionId);
    return savedConnectorStatus(config);
  }
  const { owner } = await brokerIdentity(config);
  const provider = connectionProvider(id);
  const saved = await readConnectorConnections(config, owner, provider);
  const connection = saved.find((connection) => connection.id === connectionId);
  if (!connection) throw new ApiError(404, "connector_connection_not_found", "Connection not found.");
  await brokerRequest(config, "POST", `/${encodeURIComponent(id)}/connection/disconnect`, { connectionId: connection.nangoConnectionId }, owner);
  await writeConnectorConnections(config, owner, provider, saved.filter((connection) => connection.id !== connectionId));
  await clearConnectorActivation(config, id, connectionId);
  return connectorStatus(config);
}

export function createConnectorFlows(config: ServerConfig, authorize = createNangoAuthFlow) {
  const local = createLocalOAuthFlows(config);
  const flows = new Map<string, { id: string; owner: string; expiresAt: number; connectionId?: string; auth: Awaited<ReturnType<typeof authorize>> }>();
  const admissions = new Map<string, { id: string; method: "nango" | "custom"; connectionId?: string; expiresAt: number; release: () => void; activated?: boolean }>();
  const implementation = {
    async start(id: string, connectionId?: string, method: "nango" | "custom" = "nango") {
      connectorDefinition(id);
      if (method === "custom") return local.start(id, connectionId);
      const { owner } = await brokerIdentity(config);
      await connectorVault(config).ready();
      for (const [key, flow] of flows) if (Date.now() >= flow.expiresAt) { flow.auth.cancel(); flows.delete(key); }
      if (flows.size >= 20) throw new ApiError(429, "connector_too_many_flows", "Finish or cancel an existing connection before starting another.");
      const flowId = randomUUID();
      const saved = await readConnectorConnections(config, owner, connectionProvider(id));
      requireConnectorConnectSlot(saved.map((item) => connectorConnectionSchema.parse(item)), connectionId, "nango");
      const connection = saved.find((entry) => entry.id === connectionId);
      if (connectionId && !connection) throw new ApiError(404, "connector_connection_not_found", "Connection not found.");
      const path = connection ? `/${encodeURIComponent(id)}/connection/reconnect` : `/${encodeURIComponent(id)}/connect`;
      const session = parse(sessionSchema, await brokerRequest(config, "POST", path, { flowId, ...(connection ? { connectionId: connection.nangoConnectionId } : {}) }, owner));
      if (session.expiresAt <= Date.now()) throw new ApiError(502, "connector_broker_invalid", "The sign-in session has expired.");
      const auth = await authorize(session);
      flows.set(flowId, { id, owner, expiresAt: session.expiresAt, connectionId, auth });
      return { flowId, connectUrl: auth.connectUrl, expiresAt: session.expiresAt };
    },
    async status(flowId: string) {
      if (flowId.startsWith("local-")) return local.status(flowId);
      const flow = flows.get(flowId);
      if (!flow) throw new ApiError(404, "connector_flow_not_found", "Connection flow not found. Start again.");
      if ((await brokerIdentity(config)).owner !== flow.owner) throw new ApiError(403, "connector_flow_forbidden", "This connection belongs to another Eigenwelt account.");
      if (Date.now() >= flow.expiresAt) { flow.auth.cancel(); flows.delete(flowId); return { status: "expired", connection: null }; }
      const nangoId = flow.auth.connectionId();
      if (!nangoId) return { status: "pending", connection: null };
      const provider = connectionProvider(flow.id);
      const saved = await readConnectorConnections(config, flow.owner, provider);
      const existing = saved.find((entry) => entry.nangoConnectionId === nangoId);
      if (flow.connectionId && existing?.id !== flow.connectionId) throw new ApiError(502, "connector_broker_invalid", "The sign-in returned a different account.");
      const candidate = { id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? null, needsReconnect: false, nangoConnectionId: nangoId };
      const connection = await refreshConnection(config, flow.owner, flow.id, candidate, true);
      if (flows.get(flowId) !== flow) throw new ApiError(404, "connector_flow_not_found", "Connection flow not found. Start again.");
      if (!connection || connection.needsReconnect) throw new ApiError(409, "connector_reconnect_required", "Reconnect this account to restore access.");
      const current = await readConnectorState(config, flow.owner, provider);
      const currentConnection = current.connections.find((entry) => entry.nangoConnectionId === nangoId);
      if (flow.connectionId && currentConnection?.id !== flow.connectionId) throw new ApiError(404, "connector_connection_not_found", "Connection was removed. Start again.");
      requireConnectorConnectSlot(current.connections.map((item) => connectorConnectionSchema.parse(item)), currentConnection?.id);
      connection.id = currentConnection?.id ?? connection.id;
      const written = await writeConnectorConnections(config, flow.owner, provider,
        [...current.connections.filter((entry) => entry.id !== connection.id), connection], current.snapshot, () => flows.get(flowId) === flow);
      if (!written) throw new ApiError(409, "connector_state_changed", "Your connected accounts changed. Start again.");
      return { status: "connected", connection: connectorConnectionSchema.parse(connection) };
    },
    cancel(flowId: string) {
      if (flowId.startsWith("local-")) return local.cancel(flowId);
      flows.get(flowId)?.auth.cancel(); flows.delete(flowId); return { ok: true };
    },
  };
  return {
    async start(id: string, connectionId?: string, method?: "nango" | "custom") {
      return withConnectorConnectLock(config, id, async () => {
        await connectorVault(config).ready();
        const connections = await savedConnectorConnections(config, id);
        const existing = connections.find((connection) => connection.id === connectionId);
        const selectedMethod = method ?? (existing ? existing.source ?? "nango" : defaultConnectorOAuthClient(id) ? "custom" : "nango");
        requireConnectorConnectSlot(connections, connectionId, selectedMethod);
        const reservation = reserveConnectorConnectSlot(config, id);
        try {
          const result = await implementation.start(id, connectionId, selectedMethod);
          reservation.expiresAt(result.expiresAt);
          admissions.set(result.flowId, { id, method: selectedMethod, connectionId, expiresAt: result.expiresAt, release: reservation.release });
          return result;
        } catch (error) { reservation.release(); throw error; }
      });
    },
    async status(flowId: string) {
      const admission = admissions.get(flowId);
      if (!admission) throw new ApiError(404, "connector_flow_not_found", "Connection flow not found. Start again.");
      return withConnectorConnectLock(config, admission.id, async () => {
        const managed = flows.get(flowId);
        if (managed) {
          const platform = await readEigenweltConnection(config);
          if (!platform.account || ownerKey(platform.account) !== managed.owner) throw new ApiError(403, "connector_flow_forbidden", "This connection belongs to another Eigenwelt account.");
        }
        if (Date.now() < admission.expiresAt) requireConnectorConnectSlot(await savedConnectorConnections(config, admission.id), admission.connectionId, admission.method);
        const result = await implementation.status(flowId);
        if (result.status !== "pending") {
          admission.release();
          if (result.connection) admission.connectionId = result.connection.id;
        }
        if (result.status === "connected" && result.connection && !admission.activated && admissions.get(flowId) === admission) {
          await recordConnectorActivation(config, admission.id, result.connection.id, true);
          admission.activated = true;
        }
        return result;
      });
    },
    cancel(flowId: string) {
      admissions.get(flowId)?.release(); admissions.delete(flowId);
      return implementation.cancel(flowId);
    },
  };
}
