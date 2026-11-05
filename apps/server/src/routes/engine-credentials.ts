import type { OpenCodeClient } from "@opencode/client";
import { ApiError, findApiError } from "../errors.js";
import { createEngineClient, workspaceEngineLocation } from "../engine-client.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

/** Credential values remain inside the engine, even for authenticated app clients. */
export async function engineCredentialMetadata(client: OpenCodeClient, integrationID: string) {
  return (await client.credential.list()).filter(credential => credential.integrationID === integrationID).map(credential => ({
    id: credential.id, integrationID: credential.integrationID, label: credential.label,
    active: credential.active, type: credential.value.type,
  }));
}
export async function disconnectEngineCredential(client: OpenCodeClient, integrationID: string, credentialID: string) {
  const entry = (await client.credential.list()).find(credential => credential.id === credentialID && credential.integrationID === integrationID);
  if (!entry) throw new ApiError(404, "credential_not_found", "The saved connection was not found.");
  await client.credential.remove({ credentialID });
}

export function registerEngineCredentialRoutes(options: {
  routes: Route[]; config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  ensureWritable: (config: ServerConfig) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const target = async (ctx: RequestContext) => {
    options.requireClientScope(ctx, "collaborator");
    const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
    const client = createEngineClient(options.config, workspace);
    const providerID = ctx.params.providerId;
    const provider = await client.provider.get({ providerID, location: workspaceEngineLocation(workspace) }).catch(error => { if (findApiError(error)?.status === 404) return null; throw error; });
    const integrationID = provider?.data.integrationID ?? providerID;
    // Disabled providers are absent from provider.list but keep their integration.
    await client.integration.get({ integrationID, location: workspaceEngineLocation(workspace) });
    return { client, integrationID };
  };
  addRoute(options.routes, "GET", "/workspace/:id/providers/:providerId/credentials", "client", async ctx => {
    const { client, integrationID } = await target(ctx);
    const response = options.jsonResponse({ items: await engineCredentialMetadata(client, integrationID) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  addRoute(options.routes, "DELETE", "/workspace/:id/providers/:providerId/credentials/:credentialId", "client", async ctx => {
    options.ensureWritable(options.config);
    const { client, integrationID } = await target(ctx);
    await disconnectEngineCredential(client, integrationID, ctx.params.credentialId);
    return options.jsonResponse({ ok: true });
  });
}
