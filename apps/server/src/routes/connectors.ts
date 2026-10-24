import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { connectorStatus, savedConnectorStatus, createConnectorFlows, disconnectConnector, setConnectorActivation } from "../connectors/broker.js";
import { microsoftFilesAdapter, driveListInput, siteListInput } from "../connectors/files.js";
import { createConnectorRequest } from "../connectors/request.js";
import { listGoogleSharedDrives } from "../file-storage/google-drive-tree.js";
import { connectorDefinition } from "../connectors/definition.js";
import { callConnectorExtensionAction } from "../connectors/index.js";
import { addRoute, type Route } from "./registry.js";
import { z } from "zod";
import { connectorOAuthClientInputSchema } from "../connectors/schema.js";
import { localOAuthClient, saveLocalOAuthClient, removeLocalOAuthClient } from "../connectors/local-oauth.js";

import { connectorSettings, connectorWriteSetting, saveConnectorWriteSetting } from "../connectors/settings.js";
import { deliverConnectorEmailDraft, deliverConnectorCalendarDraft, refreshConnectorCalendarDraft, reloadConnectorEmailDraft } from "../connectors/drafts.js";
import { recordAudit } from "../audit.js";

const connectionInput = z.object({ connectionId: z.string().min(1).max(500).optional(), method: z.enum(["nango", "custom"]).optional() }).strict();

export function registerConnectorRoutes(options: {
  routes: Route[]; config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readOptionalJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { routes, config, jsonResponse, readOptionalJsonBody } = options;
  const flows = createConnectorFlows(config);
  const add = (method: string, path: string, handler: Route["handler"]) => addRoute(routes, method, path, "host", async (ctx) => {
    // Personal accounts are never exposed to a shared worker's collaborators/viewers.
    if (ctx.actor?.scope === "viewer" || ctx.actor?.scope === "collaborator") throw new ApiError(403, "forbidden", "Only the LegalWork server owner can manage personal account connections.");
    if (method !== "GET" && config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    return handler(ctx);
  });
  add("GET", "/connectors/settings", async () => jsonResponse(await connectorSettings(config)));
  add("GET", "/connectors/saved", async () => jsonResponse(await savedConnectorStatus(config)));
  add("GET", "/connectors/:connectorId/saved", async (ctx) => jsonResponse(await savedConnectorStatus(config, ctx.params.connectorId)));
  add("POST", "/workspace/:workspaceId/connector-drafts/calendar/:draftId/refresh", async (ctx) => {
    const input = z.object({ revision: z.uuid() }).strict().safeParse(await readOptionalJsonBody(ctx.request));
    if (!input.success) throw new ApiError(400, "invalid_payload", "Choose a valid draft revision to refresh.");
    return jsonResponse(await refreshConnectorCalendarDraft(config, await options.resolveWorkspace(config, ctx.params.workspaceId), ctx.params.draftId, input.data.revision));
  });
  add("POST", "/workspace/:workspaceId/connector-drafts/email/:draftId/reload", async (ctx) => {
    const input = z.object({ revision: z.uuid() }).strict().safeParse(await readOptionalJsonBody(ctx.request));
    if (!input.success) throw new ApiError(400, "invalid_payload", "Choose a valid draft revision to reload.");
    const workspace = await options.resolveWorkspace(config, ctx.params.workspaceId);
    const result = await reloadConnectorEmailDraft(config, workspace, ctx.params.draftId, input.data.revision);
    await recordAudit(workspace.path, { id: randomUUID(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" }, action: "connector.email.reload", target: result.draft.path, summary: "Reloaded connected email draft", timestamp: Date.now() });
    return jsonResponse(result);
  });
  add("POST", "/workspace/:workspaceId/connector-drafts/:kind/:draftId/deliver", async (ctx) => {
    const input = z.object({ revision: z.uuid(), operation: z.enum(["save", "send"]) }).strict().safeParse(await readOptionalJsonBody(ctx.request));
    if (!input.success || !["email", "calendar"].includes(ctx.params.kind) || (ctx.params.kind === "calendar" && input.data.operation === "send")) throw new ApiError(400, "invalid_payload", "Choose a draft revision and supported action.");
    const workspace = await options.resolveWorkspace(config, ctx.params.workspaceId);
    const result = ctx.params.kind === "email"
      ? await deliverConnectorEmailDraft(config, workspace, ctx.params.draftId, input.data.revision, input.data.operation)
      : await deliverConnectorCalendarDraft(config, workspace, ctx.params.draftId, input.data.revision);
    await recordAudit(workspace.path, { id: randomUUID(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" }, action: `connector.${ctx.params.kind}.${input.data.operation}`, target: result.draft.path, summary: `Connected ${ctx.params.kind} ${input.data.operation}`, timestamp: Date.now() });
    return jsonResponse(result);
  });
  add("GET", "/connectors/:connectorId/settings", async (ctx) => jsonResponse(await connectorWriteSetting(config, ctx.params.connectorId)));
  add("PUT", "/connectors/:connectorId/settings", async (ctx) => jsonResponse(await saveConnectorWriteSetting(config, ctx.params.connectorId, await readOptionalJsonBody(ctx.request))));
  add("GET", "/connectors", async () => jsonResponse(await connectorStatus(config)));
  add("GET", "/connectors/:connectorId", async (ctx) => jsonResponse(await connectorStatus(config, ctx.params.connectorId, new URL(ctx.request.url).searchParams.get("refresh") === "true")));
  add("PUT", "/connectors/:connectorId/activation", async (ctx) => {
    const input = z.object({ connectionId: z.string().min(1).max(500), active: z.boolean() }).strict().safeParse(await readOptionalJsonBody(ctx.request));
    if (!input.success) throw new ApiError(400, "invalid_payload", "Choose the connected account and whether this connector should be active.");
    return jsonResponse(await setConnectorActivation(config, ctx.params.connectorId, input.data.connectionId, input.data.active));
  });
  add("GET", "/connectors/:connectorId/storage-locations", async (ctx) => {
    const id = ctx.params.connectorId;
    if (connectorDefinition(id).kind !== "files") throw new ApiError(400, "invalid_payload", "Choose a storage account.");
    const query = Object.fromEntries(ctx.url.searchParams);
    const { kind, ...args } = query;
    const request = await createConnectorRequest(config, id, query.connectionId);
    if (id === "google-drive") {
      if (kind !== "drives") throw new ApiError(400, "invalid_payload", "Choose a Google shared drive.");
      const input = driveListInput.parse(args);
      return jsonResponse(await listGoogleSharedDrives(request, input.pageToken));
    }
    const adapter = microsoftFilesAdapter({ personal: id === "onedrive-personal", sharepoint: id === "sharepoint-files" });
    return jsonResponse(kind === "sites" ? await adapter.sites(request, siteListInput.parse(args)) : await adapter.drives(request, driveListInput.parse(args)));
  });
  add("GET", "/connectors/:connectorId/oauth-client", async (ctx) => jsonResponse(await localOAuthClient(config, ctx.params.connectorId)));
  add("PUT", "/connectors/:connectorId/oauth-client", async (ctx) => {
    const input = connectorOAuthClientInputSchema.safeParse(await readOptionalJsonBody(ctx.request));
    if (!input.success) throw new ApiError(400, "invalid_payload", "Enter a valid OAuth client ID and app details.");
    return jsonResponse(await saveLocalOAuthClient(config, ctx.params.connectorId, input.data));
  });
  add("DELETE", "/connectors/:connectorId/oauth-client", async (ctx) => jsonResponse(await removeLocalOAuthClient(config, ctx.params.connectorId)));
  add("POST", "/connectors/:connectorId/connect", async (ctx) => {
    const body = connectionInput.safeParse(await readOptionalJsonBody(ctx.request));
    if (!body.success) throw new ApiError(400, "invalid_payload", "Invalid connection request.");
    return jsonResponse(await flows.start(ctx.params.connectorId, body.data.connectionId, body.data.method), 201);
  });
  add("GET", "/connectors/flows/:flowId", async (ctx) => jsonResponse(await flows.status(ctx.params.flowId)));
  add("DELETE", "/connectors/flows/:flowId", async (ctx) => jsonResponse(await flows.cancel(ctx.params.flowId)));
  add("DELETE", "/connectors/:connectorId/connections/:connectionId", async (ctx) => jsonResponse(await disconnectConnector(config, ctx.params.connectorId, ctx.params.connectionId)));
  add("POST", "/connectors/:connectorId/connections/:connectionId/test", async (ctx) => jsonResponse(await callConnectorExtensionAction(config, ctx.params.connectorId,
    "test_connection", { connectionId: ctx.params.connectionId }, {})));
}
