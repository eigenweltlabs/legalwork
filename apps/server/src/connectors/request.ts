import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { synchronizeConnectorBindings } from "./sync.js";
import { connectorAccessToken, connectorDefinition, listConnectorConnections, savedConnectorConnections } from "./broker.js";
import { boundedDownload } from "./native.js";
import { ensureConnectorWritesAllowed, requireConnectorActivated } from "./settings.js";
import { localOAuthConnections, requireLocalOAuthWriteAccess, requireLocalOAuthSendAccess } from "./local-oauth.js";
import { requireSingleConnectorAccount } from "./single-connection.js";

export type ConnectorRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; rawBody?: Blob; content?: boolean; bytes?: boolean;
  headers?: Record<string, string>; onResponseHeaders?: (headers: Headers) => void;
  send?: boolean; empty?: boolean; incomplete?: boolean;
};
export type ConnectorRequest = ((path: string, options?: ConnectorRequestOptions) => Promise<unknown>) & { apiOrigin?: string };
export type StreamingConnectorRequest = ConnectorRequest & {
  response: (path: string, options?: ConnectorRequestOptions) => Promise<Response>;
  assertWrite: () => Promise<void>;
};

/** Only provider adapters call this. Agents cannot supply arbitrary URLs or headers. */
export async function createConnectorRequest(config: ServerConfig, id: string, requestedConnectionId?: string): Promise<StreamingConnectorRequest> {
  const definition = connectorDefinition(id);
  const saved = await savedConnectorConnections(config, id);
  requireSingleConnectorAccount(saved);
  if (saved.length === 1) await requireConnectorActivated(config, id, saved[0].id);
  // An explicitly chosen own-app account needs no managed-account lookup.
  const local = requestedConnectionId ? (await localOAuthConnections(config, id)).find((item) => item.id === requestedConnectionId) : undefined;
  const connections = local ? [local] : await listConnectorConnections(config, id);
  requireSingleConnectorAccount(connections);
  const connection = requestedConnectionId ? connections.find((item) => item.id === requestedConnectionId) : connections.length === 1 ? connections[0] : undefined;
  if (!connection) {
    throw new ApiError(409, "connector_not_connected", `Connect ${definition.name} in Extensions before using it.`);
  }
  if (connection.needsReconnect) throw new ApiError(409, "connector_reconnect_required", `Reconnect ${definition.name} in Extensions to restore access.`);
  const apiOrigin = connection.source === "custom" && id === "onedrive-personal" ? "https://graph.microsoft.com" : definition.apiOrigin;
  const assertCurrent = async (writing: boolean) => {
    if (config.cloudSync?.role === "executor") await synchronizeConnectorBindings(config, { force: true });
    const current = await savedConnectorConnections(config, id);
    requireSingleConnectorAccount(current);
    if (!current.some((item) => item.id === connection.id && !item.needsReconnect)) throw new ApiError(409, "connector_account_changed", "This account changed. Refresh the connection before continuing.");
    await requireConnectorActivated(config, id, connection.id);
    if (writing) {
      if (connection.source === "custom") await requireLocalOAuthWriteAccess(config, id, connection.id);
    }
  };
  return createAuthorizedConnectorRequest(config, id, {
    apiOrigin, token: (force) => connectorAccessToken(config, id, connection.id, force), assertCurrent,
    assertSend: () => requireLocalOAuthSendAccess(config, id, connection.id),
  });
}

/** Reuses the exact native transport for explicitly delegated team storage.
 * Callbacks are server-owned; no caller can supply a token or provider URL. */
export async function createAuthorizedConnectorRequest(config: ServerConfig, id: string, authorization: {
  token: (forceRefresh: boolean) => Promise<string>;
  assertCurrent: (writing: boolean) => Promise<void>;
  assertSend?: () => Promise<void>;
  apiOrigin?: string;
}): Promise<StreamingConnectorRequest> {
  const definition = connectorDefinition(id);
  const apiOrigin = authorization.apiOrigin ?? definition.apiOrigin;
  const assertCurrent = async (writing: boolean) => {
    await authorization.assertCurrent(writing);
    if (writing) await ensureConnectorWritesAllowed(config, id);
  };
  await assertCurrent(false);
  let accessToken = await authorization.token(false);
  let refresh: Promise<string> | undefined;
  const responseRequest = async (path: string, options: ConnectorRequestOptions = {}) => {
    // Reject relative-path escapes and cross-origin URLs even if a future adapter passes one.
    if (!path.startsWith("/") || path.startsWith("//")) throw new ApiError(400, "connector_invalid_endpoint", "Invalid connector endpoint.");
    const origin = options.content ? definition.contentOrigin : apiOrigin;
    if (!origin) throw new ApiError(400, "connector_invalid_endpoint", "Invalid connector endpoint.");
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) throw new ApiError(400, "connector_invalid_endpoint", "Invalid connector endpoint.");
    const request = async () => {
      await assertCurrent(Boolean(options.method && options.method !== "GET"));
      if (options.method && options.method !== "GET") {
        if (options.send) {
          if (!authorization.assertSend) throw new ApiError(403, "forbidden", "This connection only authorizes storage.");
          await authorization.assertSend();
        }
      }
      try {
        return await fetch(url, { method: options.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(options.bytes || options.rawBody ? 30 * 60_000 : 30_000),
          headers: { ...options.headers, Authorization: `Bearer ${accessToken}`, Accept: options.bytes ? "*/*" : "application/json", ...(options.rawBody || options.body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(options.rawBody ? { body: options.rawBody } : options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch { throw new ApiError(502, "connector_api_unreachable", `Could not reach ${definition.name}. Try again shortly.`); }
    };
    let response = await request();
    // A rejected token has not executed the request. Retry exactly once with a refreshed token.
    if (response.status === 401) {
      refresh ??= authorization.token(true);
      accessToken = await refresh;
      response = await request();
    }
    if (!response.ok && !(options.incomplete && response.status === 308)) {
      await response.body?.cancel();
      if (response.status === 401) throw new ApiError(409, "connector_reconnect_required", `Reconnect ${definition.name} in Extensions to restore access.`);
      if (response.status === 403) throw new ApiError(403, "connector_permission_required", `This ${definition.name} account has not granted the permissions required for this action. Reconnect using an OAuth app with the required permissions. Shared Nango apps have fixed permissions; use your own OAuth app if necessary.`);
      if (response.status === 404) throw new ApiError(404, "connector_item_not_found", "The requested item was not found.");
      if (response.status === 409) throw new ApiError(409, "connector_item_conflict", "An item with that name already exists. Choose another name.");
      if (response.status === 412) throw new ApiError(409, definition.kind === "calendar" ? "connector_calendar_changed" : "connector_file_changed", definition.kind === "calendar" ? "This event changed in Google Calendar. Prepare a new update card to review the latest version." : "This file changed since you read it. Read its details again before replacing it.");
      if (response.status === 429) throw new ApiError(429, "connector_api_rate_limited", `${definition.name} is receiving too many requests. Try again shortly.`);
      throw new ApiError(502, "connector_api_failed", `${definition.name} could not complete this request.`);
    }
    options.onResponseHeaders?.(response.headers);
    return response;
  };
  const connectorRequest: StreamingConnectorRequest = Object.assign(async (path: string, options: ConnectorRequestOptions = {}) => {
    const response = await responseRequest(path, options);
    if (options.empty) { await response.body?.cancel(); return null; }
    if (options.bytes) return boundedDownload(response);
    try { return await response.json(); }
    catch { throw new ApiError(502, "connector_api_invalid", `${definition.name} returned an invalid response.`); }
  }, { response: responseRequest, assertWrite: () => assertCurrent(true) });
  connectorRequest.apiOrigin = apiOrigin;
  return connectorRequest;
}
