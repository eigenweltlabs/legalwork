import { sandboxSyncStatus, saveSandboxDefault } from "../agent-sandbox/sync.js";
import { hostShell } from "../agent-sandbox/host.js";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo, TokenScope } from "../types.js";
import type { AgentSandboxService, AgentPermissionRule } from "../agent-sandbox/service.js";
import { addRoute, type Route, type RequestContext } from "./registry.js";
import { networkModeSchema, readSandboxDefault, effectiveSandbox, sandboxSettingsSchema, writeSessionSandbox } from "../agent-sandbox/settings.js";

const commandSchema = z.object({
  command: z.string().min(1).max(128000),
  description: z.string().max(2000).optional(),
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
  sessionLineage: (workspace: WorkspaceInfo, sessionID: string) => Promise<string[]>;
  agentRules: (workspace: WorkspaceInfo, sessionID: string, agent: string) => Promise<AgentPermissionRule[]>;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  readJsonBodyLimited: (request: Request, bytes: number) => Promise<Record<string, unknown>>;
  jsonResponse: (value: unknown, status?: number) => Response;
}) {
  const { routes, config, sandbox, jsonResponse } = options;
  const assertWritable = () => {
    if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    if (!config.agentSandboxEnabled) throw new ApiError(409, "sandbox_unavailable", "This worker does not manage command execution.");
  };
  addRoute(routes, "GET", "/sandbox/status", "client", async () => {
    const settings = await readSandboxDefault(config);
    return jsonResponse({ ...settings, supported: config.agentSandboxEnabled === true, backend: "virtual-machine", sync: sandboxSyncStatus(config),
      ...(settings.enabled ? await sandbox.backend.status() : { available: null }) });
  });
  addRoute(routes, "PATCH", "/sandbox/settings", "host-token", async (ctx) => {
    assertWritable();
    const settings = sandboxSettingsSchema.parse(await options.readJsonBodyLimited(ctx.request, 1024));
    await saveSandboxDefault(config, settings);
    return jsonResponse(settings);
  });
  addRoute(routes, "GET", "/workspace/:id/sandbox/session/:sessionId", "client", async (ctx) => {
    const workspace = await options.resolveWorkspace(config, ctx.params.id);
    const lineage = await options.sessionLineage(workspace, ctx.params.sessionId);
    const { dependencies: _, ...settings } = await effectiveSandbox(config, workspace.id, lineage);
    return jsonResponse({ ...settings, supported: config.agentSandboxEnabled === true, application: await readSandboxDefault(config),
      platform: settings.enabled ? "linux" : process.platform, shell: settings.enabled ? "Bash" : hostShell(), cwd: settings.enabled ? "/workspace" : workspace.path });
  });
  addRoute(routes, "PATCH", "/workspace/:id/sandbox/session/:sessionId", "host-token", async (ctx) => {
    assertWritable();
    const workspace = await options.resolveWorkspace(config, ctx.params.id);
    await options.sessionLineage(workspace, ctx.params.sessionId);
    const { settings } = z.object({ settings: sandboxSettingsSchema.nullable() }).strict().parse(await options.readJsonBodyLimited(ctx.request, 1024));
    await writeSessionSandbox(config, workspace.id, ctx.params.sessionId, settings);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "PATCH", "/sandbox/network", "host-token", async (ctx) => {
    options.requireClientScope(ctx, "collaborator");
    if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    if (!config.agentSandboxEnabled) throw new ApiError(409, "sandbox_unavailable", "Protected execution is unavailable on this worker.");
    const input = z.object({ mode: networkModeSchema }).strict().safeParse(await options.readJsonBodyLimited(ctx.request, 1024));
    if (!input.success) throw new ApiError(400, "sandbox_network_mode", "Choose allow, block or approve for sandbox network traffic.");
    await saveSandboxDefault(config, { ...await readSandboxDefault(config), networkMode: input.data.mode });
    return jsonResponse({ networkMode: input.data.mode });
  });
  addRoute(routes, "POST", "/sandbox/prepare", "host-token", async (ctx) => {
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
    const lineage = await options.sessionLineage(workspace, input.sessionID);
    const rules = await options.agentRules(workspace, input.sessionID, input.agent);
    return jsonResponse(await sandbox.run(workspace, input, ctx.actor ?? { type: "remote", scope: "viewer" }, ctx.request.signal, rules, lineage));
  });
}
