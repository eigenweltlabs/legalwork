import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { IntegrationAttempt, OpenCodeClient } from "@opencode/client";
import { createEngineClient, workspaceEngineLocation } from "../engine-client.js";
import { assertEngineProjectReady } from "../engine-project.js";
import { resolveWorkspaceOpencodeConnection } from "../opencode-connection.js";
import { ApiError } from "../errors.js";
import type { McpRecovery } from "../mcp-recovery.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

const identity = z.object({ integrationID: z.string().min(1), attemptID: z.string().min(1) });
const callbackInput = identity.extend({ state: z.string().min(1), code: z.string().min(1).optional(), error: z.string().min(1).optional(), error_description: z.string().optional(), iss: z.string().optional() }).strict().refine(input => Boolean(input.code) !== Boolean(input.error), "A callback needs either its code or its error.");
type Binding = { actor: string; workspaceID: string; server: string; attempt: IntegrationAttempt; integrationID: string; callback: string; state: string; engine: string;
  relay?: { input: string; result: Promise<void> } };
function equal(left: string, right: string) { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
async function read<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try { value = await ctx.request.json(); } catch { throw new ApiError(400, "mcp_oauth_invalid", "The sign-in request is incomplete or invalid."); }
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, "mcp_oauth_invalid", "The sign-in request is incomplete or invalid.");
  return result.data;
}
function callbackAddress(attempt: IntegrationAttempt) {
  const authorization = new URL(attempt.url), redirect = authorization.searchParams.get("redirect_uri"), state = authorization.searchParams.get("state");
  if (!redirect || !state) throw new ApiError(502, "mcp_oauth_callback_missing", "The connection did not provide its sign-in callback.");
  const callback = new URL(redirect);
  if (callback.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname) || callback.username || callback.password || callback.search || callback.hash || !callback.port)
    throw new ApiError(502, "mcp_oauth_callback_invalid", "The connection's sign-in callback is not a supported local address.");
  return { callback: callback.href, state };
}

/** Callback transport only. Native OAuth owns attempts, state/PKCE, token
 * exchange, credential storage and refresh. No caller-provided URL is fetched. */
export function registerMcpOAuthRoutes(options: {
  routes: Route[]; config: ServerConfig;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  jsonResponse: (data: unknown, status?: number) => Response;
  recovery: Pick<McpRecovery, "mutate" | "beginAuth" | "endAuth">;
}) {
  const bindings = new Map<string, Binding>();
  const key = (integrationID: string, attemptID: string) => JSON.stringify([integrationID, attemptID]);
  const actor = (ctx: RequestContext) => {
    if (!ctx.actor) throw new ApiError(403, "mcp_oauth_owner", "The sign-in owner could not be verified.");
    return JSON.stringify([ctx.actor.type, ctx.actor.tokenHash, ctx.actor.clientId]);
  };
  async function authorize(ctx: RequestContext) {
    options.requireClientScope(ctx, "collaborator");
    if (options.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
    await assertEngineProjectReady(options.config, workspace);
    const client = createEngineClient(options.config, workspace), location = workspaceEngineLocation(workspace);
    const connection = resolveWorkspaceOpencodeConnection(options.config, workspace);
    const engine = JSON.stringify([connection.baseUrl, connection.authHeader]);
    for (const [id, binding] of bindings) if (binding.attempt.time.expires <= Date.now()) bindings.delete(id);
    return { workspace, client, location, engine, owner: actor(ctx) };
  }
  async function owned(ctx: RequestContext, input: { integrationID: string; attemptID: string }) {
    const auth = await authorize(ctx), binding = bindings.get(key(input.integrationID, input.attemptID));
    if (!binding || binding.actor !== auth.owner || binding.workspaceID !== auth.workspace.id || binding.engine !== auth.engine)
      throw new ApiError(403, "mcp_oauth_owner", "This sign-in attempt belongs to another connection or has expired.");
    return { ...auth, binding };
  }
  const status = async (client: OpenCodeClient, location: { directory: string }, binding: Binding) => {
    const result = (await client.integration.oauth.status({ location, integrationID: binding.integrationID, attemptID: binding.attempt.attemptID })).data;
    if (result.status === "pending") options.recovery.beginAuth(binding.server, result.time.expires);
    else options.recovery.endAuth(binding.server);
    return result;
  };
  const prefix = "/workspace/:id/mcp/oauth";
  addRoute(options.routes, "POST", `${prefix}/start`, "client", async ctx => {
    const { server } = await read(ctx, z.object({ server: z.string().min(1) }).strict());
    const auth = await authorize(ctx);
    await auth.client.model.list({ location: auth.location });
    const entry = (await auth.client.mcp.list({ location: auth.location })).data.find(entry => entry.name === server);
    if (!entry?.integrationID) throw new ApiError(404, "mcp_oauth_missing", "The connection has no native sign-in integration.");
    const integrationID = entry.integrationID, integration = await auth.client.integration.get({ integrationID, location: auth.location });
    const method = integration.data.methods.find(method => method.type === "oauth");
    if (!method || method.type !== "oauth") throw new ApiError(409, "mcp_oauth_unavailable", "This connection does not offer browser sign-in.");
    const attempt = await options.recovery.mutate(server, async () => {
      const value = (await auth.client.integration.oauth.connect({ integrationID, methodID: method.id, location: auth.location })).data;
      options.recovery.beginAuth(server, value.time.expires);
      return value;
    });
    try {
      const callback = callbackAddress(attempt);
      bindings.set(key(integrationID, attempt.attemptID), { actor: auth.owner, workspaceID: auth.workspace.id, server, attempt, integrationID, ...callback, engine: auth.engine });
      return options.jsonResponse({ integrationID, ...attempt, callback: { redirectUri: callback.callback } });
    } catch (error) { await auth.client.integration.oauth.cancel({ integrationID, attemptID: attempt.attemptID, location: auth.location }); options.recovery.endAuth(server); throw error; }
  });
  addRoute(options.routes, "POST", `${prefix}/status`, "client", async ctx => {
    const input = await read(ctx, identity.strict()), auth = await owned(ctx, input);
    return options.jsonResponse(await status(auth.client, auth.location, auth.binding));
  });
  addRoute(options.routes, "POST", `${prefix}/cancel`, "client", async ctx => {
    const input = await read(ctx, identity.strict()), auth = await owned(ctx, input);
    await auth.client.integration.oauth.cancel({ ...input, location: auth.location });
    options.recovery.endAuth(auth.binding.server);
    bindings.delete(key(input.integrationID, input.attemptID));
    return options.jsonResponse({ ok: true });
  });
  addRoute(options.routes, "POST", `${prefix}/relay`, "client", async ctx => {
    const input = await read(ctx, callbackInput), auth = await owned(ctx, input), binding = auth.binding;
    if (!equal(input.state, binding.state)) throw new ApiError(409, "mcp_oauth_state", "This sign-in response belongs to another attempt.");
    const before = await status(auth.client, auth.location, binding);
    if (before.status !== "pending") return options.jsonResponse(before);
    const payload = JSON.stringify([input.state, input.code, input.error, input.error_description, input.iss]);
    if (binding.relay && binding.relay.input !== payload) throw new ApiError(409, "mcp_oauth_callback_used", "A different sign-in response has already been delivered.");
    if (!binding.relay) {
      const callback = new URL(binding.callback);
      for (const name of ["state", "code", "error", "error_description", "iss"] as const) if (input[name] !== undefined) callback.searchParams.set(name, input[name]);
      // Keep a rejected/uncertain delivery recorded too: retrying a mutation
      // cannot safely repeat a native OAuth exchange. Status remains readable.
      const result = (async () => {
        const response = await fetch(callback, { redirect: "error", signal: ctx.request.signal });
        await response.body?.cancel();
        const settled = await status(auth.client, auth.location, binding);
        if (!response.ok && settled.status === "pending") throw new ApiError(502, "mcp_oauth_callback_failed", "Sign-in delivery could not be confirmed. Check its status before trying again.");
      })();
      binding.relay = { input: payload, result };
    }
    await binding.relay.result;
    return options.jsonResponse(await status(auth.client, auth.location, binding));
  });
}
