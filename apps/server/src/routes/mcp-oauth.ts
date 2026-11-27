import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { IntegrationAttempt, IntegrationAttemptStatus, OpenCodeClient } from "@opencode/client";
import { githubMcpOAuth, isCredentialHeader } from "../connector-config.js";
import { createEngineClient, workspaceEngineLocation } from "../engine-client.js";
import { assertEngineProjectReady } from "../engine-project.js";
import { resolveWorkspaceOpencodeConnection } from "../opencode-connection.js";
import { ApiError } from "../errors.js";
import type { McpRecovery } from "../mcp-recovery.js";
import { pollGitHubDeviceOAuth, startGitHubDeviceOAuth } from "../github-mcp-oauth.js";
import { runtimeMcpMapForWorkspace } from "../mcp.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

const identity = z.object({ integrationID: z.string().min(1), attemptID: z.string().min(1) });
const callbackInput = identity.extend({ state: z.string().min(1), code: z.string().min(1).optional(), error: z.string().min(1).optional(), error_description: z.string().optional(), iss: z.string().optional() }).strict().refine(input => Boolean(input.code) !== Boolean(input.error), "A callback needs either its code or its error.");
const githubAppConfig = z.object({
  type: z.literal("remote"),
  url: z.literal(githubMcpOAuth.url),
  disabled: z.literal(false).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: z.object({ client_id: z.literal(githubMcpOAuth.clientId), client_secret: z.undefined() }),
});
function isGitHubAppConfig(value: unknown): boolean {
  const parsed = githubAppConfig.safeParse(value);
  return parsed.success && !Object.keys(parsed.data.headers ?? {}).some(isCredentialHeader);
}
type AttemptBinding = { actor: string; workspaceID: string; server: string; attempt: IntegrationAttempt; integrationID: string; engine: string };
type CallbackBinding = AttemptBinding & { callback: string; state: string; relay?: { input: string; result: Promise<void> } };
type DeviceBinding = AttemptBinding & {
  deviceCode: string; methodID: string; interval: number; pollAt: number;
  polling?: Promise<IntegrationAttemptStatus>;
  settled?: IntegrationAttemptStatus;
};
type Binding = CallbackBinding | DeviceBinding;
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

/** Native callback transport and the built-in GitHub device grant. OpenCode
 * owns the credential store and refresh for both paths. */
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
  type Auth = Awaited<ReturnType<typeof authorize>>;
  async function storedGitHubApp(auth: Auth, server: string) {
    return server === githubMcpOAuth.name && isGitHubAppConfig((await runtimeMcpMapForWorkspace(options.config, auth.workspace.id))[server]);
  }
  async function activeGitHubApp(auth: Auth, server: string) {
    const documents = await auth.client.config.get({ location: auth.location });
    const effective = documents.flatMap(document => document.type === "document" && document.info.mcp?.servers?.[server] ? [document.info.mcp.servers[server]] : []).at(-1);
    return isGitHubAppConfig(effective);
  }
  function deviceStatus(auth: Auth, binding: DeviceBinding): Promise<IntegrationAttemptStatus> {
    const { time, attemptID } = binding.attempt;
    const pending: IntegrationAttemptStatus = { status: "pending", time };
    if (binding.settled) return Promise.resolve(binding.settled);
    if (binding.polling) return binding.polling;
    if (Date.now() < binding.pollAt) return Promise.resolve(pending);
    const live = () => bindings.get(key(binding.integrationID, attemptID)) === binding && Date.now() < time.expires;
    const settle = (result: IntegrationAttemptStatus) => {
      binding.settled = result;
      binding.deviceCode = "";
      options.recovery.endAuth(binding.server);
      return result;
    };
    binding.polling = options.recovery.mutate(binding.server, async () => {
      if (!live()) return settle({ status: "expired", time });
      const result = await pollGitHubDeviceOAuth(binding.deviceCode);
      if (!live()) return settle({ status: "expired", time });
      if (result.status === "slow_down") binding.interval = Math.max(binding.interval + 5_000, (result.interval ?? 0) * 1000);
      binding.pollAt = Date.now() + binding.interval;
      if (result.status === "pending" || result.status === "slow_down") return pending;
      if (result.status === "expired") return settle({ status: "expired", time });
      if (result.status === "failed") return settle({ status: "failed", time, message: result.message });
      const available = await storedGitHubApp(auth, binding.server) && await activeGitHubApp(auth, binding.server);
      if (!live()) return settle({ status: "expired", time });
      if (!available) return settle({ status: "failed", time, message: "The GitHub connection changed. Start a new sign-in." });
      const { token } = result;
      const value: Parameters<OpenCodeClient["credential"]["create"]>[0]["value"] = {
        type: "oauth", methodID: binding.methodID, access: token.access_token,
        refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000,
        metadata: { serverUrl: githubMcpOAuth.url, tokenType: token.token_type, scope: token.scope, client: { client_id: githubMcpOAuth.clientId } },
      };
      await auth.client.credential.create({ integrationID: binding.integrationID, label: "GitHub", value, activate: true });
      return settle({ status: "complete", time });
    }).catch(() => settle({ status: "failed", time, message: "GitHub sign-in could not finish. Please try again." })).finally(() => {
      binding.polling = undefined;
    });
    return binding.polling;
  }
  const status = async (client: OpenCodeClient, location: { directory: string }, binding: CallbackBinding) => {
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
    const owner = { actor: auth.owner, workspaceID: auth.workspace.id, server, integrationID, engine: auth.engine };
    if (await storedGitHubApp(auth, server)) {
      return options.recovery.mutate(server, async () => {
        if (!(await activeGitHubApp(auth, server))) throw new ApiError(409, "github_oauth_config_changed", "The GitHub connection is unavailable. Refresh and try signing in again.");
        if ([...bindings.values()].some(binding => "deviceCode" in binding && !binding.settled && binding.integrationID === integrationID && binding.engine === auth.engine)) {
          throw new ApiError(409, "github_oauth_in_progress", "Another GitHub sign-in is already in progress. Finish or cancel it first.");
        }
        const device = await startGitHubDeviceOAuth();
        const attempt: IntegrationAttempt = { attemptID: randomUUID(), mode: "auto", url: device.url, instructions: "", time: device.time };
        bindings.set(key(integrationID, attempt.attemptID), {
          ...owner, attempt, deviceCode: device.deviceCode, methodID: method.id, interval: device.interval,
          pollAt: device.time.created + device.interval,
        });
        options.recovery.beginAuth(server, device.time.expires);
        const response = options.jsonResponse({ integrationID, ...attempt, userCode: device.userCode });
        response.headers.set("Cache-Control", "no-store");
        return response;
      });
    }
    const attempt = await options.recovery.mutate(server, async () => {
      const value = (await auth.client.integration.oauth.connect({ integrationID, methodID: method.id, location: auth.location })).data;
      options.recovery.beginAuth(server, value.time.expires);
      return value;
    });
    try {
      const callback = callbackAddress(attempt);
      bindings.set(key(integrationID, attempt.attemptID), { ...owner, attempt, ...callback });
      return options.jsonResponse({ integrationID, ...attempt, callback: { redirectUri: callback.callback } });
    } catch (error) { await auth.client.integration.oauth.cancel({ integrationID, attemptID: attempt.attemptID, location: auth.location }); options.recovery.endAuth(server); throw error; }
  });
  addRoute(options.routes, "POST", `${prefix}/status`, "client", async ctx => {
    const input = await read(ctx, identity.strict()), auth = await owned(ctx, input);
    const result = "deviceCode" in auth.binding ? await deviceStatus(auth, auth.binding) : await status(auth.client, auth.location, auth.binding);
    return options.jsonResponse(result);
  });
  addRoute(options.routes, "POST", `${prefix}/cancel`, "client", async ctx => {
    const input = await read(ctx, identity.strict()), auth = await owned(ctx, input);
    if (!("deviceCode" in auth.binding)) await auth.client.integration.oauth.cancel({ ...input, location: auth.location });
    options.recovery.endAuth(auth.binding.server);
    bindings.delete(key(input.integrationID, input.attemptID));
    return options.jsonResponse({ ok: true });
  });
  addRoute(options.routes, "POST", `${prefix}/relay`, "client", async ctx => {
    const input = await read(ctx, callbackInput), auth = await owned(ctx, input), binding = auth.binding;
    if ("deviceCode" in binding) throw new ApiError(409, "mcp_oauth_callback_invalid", "This sign-in completes through GitHub.");
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
