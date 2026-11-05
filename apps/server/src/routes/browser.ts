import { Browser } from "@opencode/plugin-browser/rpc";
import { Schema } from "effect";
import { z } from "zod";
import { createBrowserExtensionChannel } from "../browser-extension-channel.js";
import { effectiveSandbox } from "../agent-sandbox/settings.js";
import { createEngineClient, getWorkspaceEngineSession } from "../engine-client.js";
import { assertEngineProjectReady } from "../engine-project.js";
import { ApiError } from "../errors.js";
import { resolveWorkspaceOpencodeConnection } from "../opencode-connection.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type Options = {
  routes: Route[]; config: ServerConfig;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  jsonResponse: (data: unknown, status?: number) => Response;
};
/** Browser RPC only. Engine authentication and every unrelated native API stay private. */
export function registerBrowserRoutes(options: Options): void {
  const extensions = createBrowserExtensionChannel();
  const owners = new Map<string, { actor: string; sessionID: string; workspaceID: string }>();
  const actor = (ctx: RequestContext) => {
    if (!ctx.actor) throw new ApiError(403, "browser_owner", "The desktop browser owner could not be verified.");
    return JSON.stringify([ctx.actor.type, ctx.actor.tokenHash, ctx.actor.clientId]);
  };
  async function authorize(ctx: RequestContext) {
    options.requireClientScope(ctx, "collaborator");
    if (options.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
    const client = createEngineClient(options.config, workspace);
    const session = await getWorkspaceEngineSession(client, workspace, ctx.params.sessionID);
    if (session.agent === "legalwork-scheduled-project" || session.agent === "document-extractor" || session.metadata?.legalworkReviewWorker === true)
      throw new ApiError(403, "browser_worker", "This internal worker cannot control a desktop browser.");
    await assertEngineProjectReady(options.config, workspace);
    const lineage: string[] = []; let current = session;
    while (true) {
      if (lineage.includes(current.id)) throw new ApiError(403, "browser_lineage", "The chat ancestry could not be verified.");
      lineage.push(current.id);
      if (!current.parentID) break;
      current = await getWorkspaceEngineSession(client, workspace, current.parentID);
    }
    const policy = await effectiveSandbox(options.config, workspace.id, lineage);
    if (policy.enabled && policy.networkMode !== "allow") throw new ApiError(403, "browser_network_denied", "Desktop browsing requires allowed network access for this chat.");
    const connection = resolveWorkspaceOpencodeConnection(options.config, workspace);
    if (!connection.baseUrl) throw new ApiError(503, "opencode_unavailable", "The browser engine is unavailable.");
    const headers: Record<string, string> = {};
    if (connection.authHeader) headers.Authorization = connection.authHeader;
    return { workspace, session, baseUrl: connection.baseUrl, headers };
  }
  const prefix = "/workspace/:id/browser/:sessionID/api";
  const extensionPrefix = "/workspace/:id/browser/:sessionID/extensions";
  async function extension(ctx: RequestContext, desktop: boolean) {
    const authorized = await authorize(ctx), binding = extensions.binding(ctx.params.capability);
    if (binding.sessionID !== ctx.params.sessionID || binding.workspaceID !== authorized.workspace.id || desktop && binding.actor !== actor(ctx))
      throw new ApiError(403, "browser_owner", "This desktop attachment belongs to another client.");
    return binding;
  }
  addRoute(options.routes, "POST", `${extensionPrefix}/register`, "client", async ctx => {
    const authorized = await authorize(ctx);
    const { tabID } = z.object({ tabID: z.string().min(1) }).strict().parse(await ctx.request.json());
    return options.jsonResponse({ capability: extensions.register({ actor: actor(ctx), sessionID: ctx.params.sessionID, workspaceID: authorized.workspace.id, tabID }) });
  });
  addRoute(options.routes, "GET", `${extensionPrefix}/:capability/next`, "client", async ctx => {
    await extension(ctx, true);
    return options.jsonResponse(await extensions.next(ctx.params.capability, ctx.request.signal));
  });
  addRoute(options.routes, "POST", `${extensionPrefix}/:capability/result`, "client", async ctx => {
    await extension(ctx, true);
    const value = z.object({ requestID: z.string(), status: z.number().int().min(100).max(599), payload: z.unknown() }).strict().parse(await ctx.request.json());
    extensions.result(ctx.params.capability, value.requestID, value);
    return options.jsonResponse({ ok: true });
  });
  addRoute(options.routes, "DELETE", `${extensionPrefix}/:capability`, "client", async ctx => {
    await extension(ctx, true); extensions.close(ctx.params.capability); return options.jsonResponse({ ok: true });
  });
  for (const method of ["GET", "POST"]) addRoute(options.routes, method, `${extensionPrefix}/:capability/execute/:operation`, "client", async ctx => {
    await extension(ctx, false);
    if (ctx.request.headers.get("x-legalwork-browser-session") !== ctx.params.sessionID) throw new ApiError(403, "browser_session", "The calling chat does not own this browser capability.");
    const operation = z.enum(["batch", "downloads", "upload", "capture", "download"]).parse(ctx.params.operation);
    if (method !== (operation === "downloads" ? "GET" : "POST")) throw new ApiError(405, "browser_method", "The browser operation uses another method.");
    const result = await extensions.request(ctx.params.capability, operation, method === "GET" ? undefined : await ctx.request.json(), ctx.request.signal);
    return options.jsonResponse(result.payload, result.status);
  });
  addRoute(options.routes, "GET", `${prefix}/session/:targetID`, "client", async ctx => {
    if (ctx.params.targetID !== ctx.params.sessionID) throw new ApiError(403, "browser_session", "This gateway belongs to another chat.");
    return options.jsonResponse({ data: (await authorize(ctx)).session });
  });
  addRoute(options.routes, "POST", `${prefix}/rpc/:rpcID/:method`, "client", async ctx => {
    const method = ctx.params.method;
    if (ctx.params.rpcID !== Browser.Definition.id || !Object.hasOwn(Browser.Definition.methods, method))
      throw new ApiError(404, "browser_rpc", "Only native desktop browser methods are available here.");
    const authorized = await authorize(ctx);
    // Decode with the released protocol itself; keep its original encoded bytes intact.
    const body: unknown = await ctx.request.json();
    if (!body || typeof body !== "object" || !("input" in body)) throw new ApiError(400, "browser_input", "Browser input is required.");
    const definition = Browser.Definition.methods[method as keyof typeof Browser.Definition.methods];
    const decoded = Schema.decodeUnknownSync(definition.input)(body.input);
    if (decoded.sessionID !== ctx.params.sessionID) throw new ApiError(403, "browser_session", "This gateway belongs to another chat.");
    const owner = owners.get(decoded.connectionID), identity = actor(ctx);
    if (method === "attach") {
      if (owner) throw new ApiError(409, "browser_connection_reused", "A browser attachment identity cannot be reused.");
      owners.set(decoded.connectionID, { actor: identity, sessionID: decoded.sessionID, workspaceID: authorized.workspace.id });
    } else if (!owner || owner.actor !== identity || owner.sessionID !== decoded.sessionID || owner.workspaceID !== authorized.workspace.id)
      throw new ApiError(403, "browser_owner", "This desktop browser attachment belongs to another client.");
    try {
      const response = await fetch(`${authorized.baseUrl.replace(/\/$/, "")}/api/rpc/${encodeURIComponent(Browser.Definition.id)}/${encodeURIComponent(method)}`, {
        method: "POST", headers: { ...authorized.headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctx.request.signal, redirect: "error",
      });
      return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } finally { if (method === "attach") owners.delete(decoded.connectionID); }
  });
  addRoute(options.routes, "GET", `${prefix}/event`, "client", async ctx => {
    const authorized = await authorize(ctx), identity = actor(ctx);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, ctx.request.signal]);
    const response = await fetch(`${authorized.baseUrl.replace(/\/$/, "")}/api/event`, { headers: authorized.headers, signal, redirect: "error" });
    if (!response.ok || !response.body) { abort.abort(); throw new ApiError(502, "browser_events", "The engine browser event stream is unavailable."); }
    const reader = response.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
    let pending = "", checking = false;
    const timer = setInterval(() => {
      if (checking) return; checking = true;
      void authorize(ctx).catch(error => abort.abort(error)).finally(() => { checking = false; });
    }, 1000); timer.unref();
    const cleanup = () => { clearInterval(timer); abort.abort(); void reader.cancel().catch(() => undefined); };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const separator = pending.search(/\r?\n\r?\n/);
            if (separator >= 0) {
              const frame = pending.slice(0, separator); pending = pending.slice(separator).replace(/^\r?\n\r?\n/, "");
              const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data) continue;
              const event: unknown = JSON.parse(data);
              if (!event || typeof event !== "object" || !("type" in event)) continue;
              if (event.type === "server.connected") { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); return; }
              if (event.type !== "rpc.experimental.browser.control" || !("data" in event) || !event.data || typeof event.data !== "object" || !("connectionID" in event.data) || typeof event.data.connectionID !== "string") continue;
              const owner = owners.get(event.data.connectionID);
              if (owner?.actor === identity && owner.sessionID === ctx.params.sessionID && owner.workspaceID === authorized.workspace.id) { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); return; }
              continue;
            }
            const chunk = await reader.read();
            if (chunk.done) { cleanup(); controller.close(); return; }
            pending += decoder.decode(chunk.value, { stream: true });
          }
        } catch (error) { cleanup(); controller.error(error); }
      }, cancel: cleanup,
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  });
}
