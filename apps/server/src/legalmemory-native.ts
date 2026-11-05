import { LegalMemoryPermissionsSchema, LegalMemoryPermissionReplySchema } from "./native-shared-values.js";
import type { LegalMemoryPermissionReply } from "@legalwork/types/legalmemory";
import { z } from "zod";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { createEngineClient, workspaceEngineLocation } from "./engine-client.js";
import { firmHubConnectorBlocks } from "./firm-hub.js";
import { allowedMemberConnectors } from "./org-policy-items.js";
import type { LegalMemoryClient } from "./legalmemory-fetch.js";
import { LegalMemoryAccessError, legalMemoryRpc, legalMemoryReadTools, legalMemoryResponseSchema, type LegalMemoryRequest } from "./legalmemory-rpc.js";
import { ApiError } from "./errors.js";

/** Authenticated LegalWork routes own member/firm scope; engine RPC owns OAuth. */
export async function createNativeLegalMemoryClient(config: ServerConfig, workspace: WorkspaceInfo, signal?: AbortSignal): Promise<LegalMemoryClient> {
  const engine = createEngineClient(config, workspace), location = workspaceEngineLocation(workspace);
  // Released plugin/MCP discovery begins with the model catalog, without inference.
  // Only native-resolved names cross RPC; URLs, headers and credentials stay inside.
  await engine.model.list({ location }, { signal });
  const available = z.object({ names: z.array(z.string()) }).parse(await engine.rpc(legalMemoryRpc).servers({}, { location, signal }));
  const allowed = await allowedMemberConnectors(config, Object.fromEntries(available.names.map(name => [name, true])));
  const firm = await firmHubConnectorBlocks(config);
  const name = available.names.find(name => Object.hasOwn(firm, name)) ?? available.names.find(name => Object.hasOwn(allowed, name));
  if (!name) throw new ApiError(409, "legalmemory_not_configured", "No permitted LegalMemory connection is configured for this project.");
  const request = async (operation: LegalMemoryRequest["operation"]) => {
    signal?.throwIfAborted();
    const response = legalMemoryResponseSchema.parse(await engine.rpc(legalMemoryRpc).request({ serverName: name, operation }, { location, signal }));
    if (!response.ok) throw new LegalMemoryAccessError(response.code, response.message);
    return response.value;
  };
  return {
    callTool: (name, args) => request({ type: "tool", name: z.enum(legalMemoryReadTools).parse(name), args: z.record(z.string(), z.json()).parse(args) }),
    tree: (name, params) => request({ type: "tree", name, params: Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined)) }),
  };
}

export function legalMemoryRouteError(error: unknown, code: string, fallback: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof LegalMemoryAccessError) {
    if (error.code === "permission_denied") return new ApiError(403, "legalmemory_access_denied", error.message);
    if (error.code === "not_configured") return new ApiError(409, "legalmemory_not_configured", error.message);
    if (error.code === "cancelled") return new ApiError(499, "request_cancelled", error.message);
  }
  return new ApiError(502, code, error instanceof Error ? error.message : fallback);
}


export async function listNativeLegalMemoryPermissions(config: ServerConfig, workspace: WorkspaceInfo, signal?: AbortSignal) {
  const engine = createEngineClient(config, workspace);
  const pending = await engine.rpc(legalMemoryRpc).permissions({}, { location: workspaceEngineLocation(workspace), signal });
  return LegalMemoryPermissionsSchema.parse({ workspace: { id: workspace.id, name: workspace.name }, ...pending });
}
export async function replyNativeLegalMemoryPermission(config: ServerConfig, workspace: WorkspaceInfo, raw: LegalMemoryPermissionReply, signal?: AbortSignal) {
  const input = LegalMemoryPermissionReplySchema.parse(raw);
  const result = z.object({ replied: z.boolean() }).parse(await createEngineClient(config, workspace).rpc(legalMemoryRpc).reply(input, { location: workspaceEngineLocation(workspace), signal }));
  if (!result.replied) throw new ApiError(409, "legalmemory_permission_stale", "This LegalMemory read is no longer waiting for that permission.");
  return result;
}
