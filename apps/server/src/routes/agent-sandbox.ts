import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo, TokenScope } from "../types.js";
import type { AgentSandboxService, AgentPermissionRule } from "../agent-sandbox/service.js";
import { addRoute, type Route, type RequestContext } from "./registry.js";

const commandSchema = z.object({
  command: z.string().min(1).max(128000),
  workdir: z.string().max(4096).optional(),
  skills: z.array(z.string().min(1).max(200)).max(16).optional(),
  write: z.boolean().default(false),
  timeoutMs: z.number().int().min(1).max(600000).default(120000),
  agent: z.string().min(1).max(200),
  sessionID: z.string().min(1).max(200),
}).strict();

export function registerAgentSandboxRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  sandbox: AgentSandboxService;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  agentRules: (workspace: WorkspaceInfo, sessionID: string, agent: string) => Promise<AgentPermissionRule[]>;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  readJsonBodyLimited: (request: Request, bytes: number) => Promise<Record<string, unknown>>;
  jsonResponse: (value: unknown, status?: number) => Response;
}) {
  const { routes, config, sandbox, jsonResponse } = options;
  addRoute(routes, "GET", "/sandbox/status", "client", async () => jsonResponse({
    enabled: config.agentSandboxEnabled === true,
    backend: "virtual-machine",
    ...await sandbox.backend.status(),
  }));
  addRoute(routes, "POST", "/sandbox/prepare", "client", async (ctx) => {
    options.requireClientScope(ctx, "collaborator");
    if (!config.agentSandboxEnabled) throw new ApiError(409, "sandbox_unavailable", "This worker does not manage its agent sandbox.");
    await sandbox.backend.prepare();
    return jsonResponse({ ready: true });
  });
  addRoute(routes, "POST", "/workspace/:id/sandbox/execute", "client", async (ctx) => {
    options.requireClientScope(ctx, "collaborator");
    if (!config.agentSandboxEnabled) throw new ApiError(409, "sandbox_unavailable", "Protected execution is unavailable on this worker.");
    const input = commandSchema.parse(await options.readJsonBodyLimited(ctx.request, 256000));
    const workspace = await options.resolveWorkspace(config, ctx.params.id);
    const rules = await options.agentRules(workspace, input.sessionID, input.agent);
    return jsonResponse(await sandbox.run(workspace, input, ctx.actor ?? { type: "remote", scope: "viewer" }, ctx.request.signal, rules));
  });
}
