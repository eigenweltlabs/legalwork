import { LegalMemoryPermissionReplySchema, type LegalMemoryPermission } from "@legalwork/types/legalmemory";
import { LEGALMEMORY_INTERNAL_SESSION } from "@legalwork/types/session-visibility";
import { setTimeout } from "node:timers/promises";
import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { Tool } from "@opencode/schema/tool";
import { Session } from "@opencode/schema/session";
import { Agent } from "@opencode/schema/agent";
import { SessionMessage } from "@opencode/schema/session-message";
import type { Mcp } from "@opencode/schema/mcp";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readManagedEngineSettings } from "../managed-engine-settings.js";
import { legalMemoryTreeApiUrl, legalMemoryTreeProxyUrl } from "../legalmemory-fetch.js";
import { legalMemoryReadTools, legalMemoryRequestSchema, legalMemoryResponseSchema, legalMemoryRpc, LegalMemoryAccessError, type LegalMemoryRequest, type LegalMemoryResponse } from "../legalmemory-rpc.js";

const namespace = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
const action = (server: string, name: string) => `${namespace(server)}_${namespace(name)}`;
const internal = (session: { metadata?: Record<string, unknown> | null }) => session.metadata?.legalworkInternal === LEGALMEMORY_INTERNAL_SESSION;
const source = (call: ToolContext) => ({ type: "tool" as const, messageID: call.messageID, id: call.id });

async function assertRead(ctx: Plugin.Context, call: ToolContext, name: string) {
  call.signal.throwIfAborted();
  const finished = new AbortController();
  // Promise-domain permission.assert has no AbortSignal option. If the caller
  // cancels while a firm policy is still evaluating, reject only the eventual
  // request with this exact invocation source. The cadence is observation,
  // not a deadline, retry allowance, or limit on user approval time.
  const cancelPermission = async () => {
    while (!finished.signal.aborted) {
      const requests = await ctx.permission.list({ sessionID: call.sessionID });
      for (const request of requests) if (request.source?.type === "tool" && request.source.id === call.id && request.source.messageID === call.messageID) {
        await ctx.permission.reply({ sessionID: call.sessionID, requestID: request.id, decision: "reject" });
      }
      await setTimeout(50, undefined, { signal: finished.signal }).catch(() => {});
    }
  };
  const abort = () => { void cancelPermission().catch(() => {}); };
  call.signal.addEventListener("abort", abort, { once: true });
  try { await ctx.permission.assert({ sessionID: call.sessionID, agent: call.agent, action: name, resources: ["*"], save: [], source: source(call) }); }
  catch { throw new LegalMemoryAccessError("permission_denied", "LegalMemory read access was denied."); }
  finally { finished.abort(); call.signal.removeEventListener("abort", abort); }
  call.signal.throwIfAborted();
}

function safeRemote(config: Mcp.ServerConfig | undefined, expected: LegalMemoryRequest): Mcp.RemoteConfig {
  if (!/^(?:legal[_-]?memory|knowledge[_-]?index)$/i.test(expected.serverName)
    || config?.type !== "remote" || config.disabled) {
    throw new LegalMemoryAccessError("not_configured", "This exact LegalMemory connection is not enabled for this project.");
  }
  const url = new URL(config.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new LegalMemoryAccessError("not_configured", "The configured LegalMemory URL is not a supported HTTP endpoint.");
  }
  return config;
}

/** Native public tool execution retains native permission assertions, transport,
 * OAuth refresh and cancellation. It deliberately never reads tool-output paths. */
async function executeNative(ctx: Plugin.Context, call: ToolContext, server: string, name: string, args: Record<string, unknown>) {
  const tool = (await ctx.tool.list()).find(tool => tool.id === action(server, name) && tool.name === name && tool.options?.namespace === namespace(server));
  if (!tool) throw new LegalMemoryAccessError("tool_unavailable", `LegalMemory does not expose the required ${name} read operation.`);
  // Native MCP Info.execute itself asserts the exact server_tool action,
  // wildcard resource and invocation source. An outer assertion would ask twice.
  return tool.execute(args, call);
}

/** Convert native typed results to the existing complete MCP data envelope. */
function nativeEnvelope(result: Awaited<ReturnType<typeof executeNative>>) {
  return {
    result: {
      ...(result.output === undefined ? {} : { structuredContent: result.output }),
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      content: typeof result.content === "string" ? [{ type: "text", text: result.content }] : (result.content ?? []).map(part => {
        if (part.type === "text") return part;
        const data = /^data:([^;,]+);base64,(.*)$/s.exec(part.uri);
        return data ? { type: "resource", resource: { uri: part.uri, mimeType: part.mime, blob: data[2], ...(part.name ? { name: part.name } : {}) } } : part;
      }),
    },
  };
}

function rpcMessage(text: string, id: number): unknown {
  let message: unknown; try { message = JSON.parse(text); } catch { return undefined; }
  if (!message || typeof message !== "object" || !("id" in message) || message.id !== id) return undefined;
  if ("error" in message) throw new LegalMemoryAccessError("request_failed", "LegalMemory refused the requested download operation.");
  return message;
}

/** A valid MCP SSE reply may leave its stream open after the matching result.
 * Read the complete matching frame without imposing an output size limit. */
async function parseRpc(response: Response, id: number): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const message = rpcMessage(await response.text(), id);
    if (message !== undefined) return message;
  } else if (response.body) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          const message = rpcMessage(data, id);
          if (message !== undefined) return message;
        }
        if (chunk.done) {
          const data = buffer.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          const message = rpcMessage(data, id); if (message !== undefined) return message;
          break;
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  throw new LegalMemoryAccessError("request_failed", "LegalMemory returned an invalid download response.");
}

export default Plugin.define({
  id: "legalwork.legalmemory-access",
  async setup(ctx) {
    const settingsPath = ctx.options.settingsPath;
    if (typeof settingsPath !== "string") throw new Error("LegalWork managed settings are required for LegalMemory access.");
    let definitions = new Map<string, Mcp.ServerConfig>();
    const operations = new Map<string, ToolContext>();
    const deniedSources = new Set<string>();
    // Native MCP lowering intentionally generalizes errors. Observe its actual
    // permission decision without changing it, so the UI still reports denial.
    const permissionObserver = await ctx.permission.hook("evaluate", event => {
      const source = event.source;
      if (event.effect === "deny" && source?.type === "tool" && Array.from(operations.values()).some(call => call.id === source.id && call.messageID === source.messageID && call.sessionID === event.sessionID)) deniedSources.add(source.id);
    });
    const transform = await ctx.mcp.transform(editor => { definitions = new Map(editor.list()); });
    const processStartedAt = Date.now() - process.uptime() * 1000;
    let cleanupPromise: Promise<number> | undefined;
    const cleanupOrphans = async () => {
      let removed = 0;
      let cursor: string | undefined;
      do {
        const page = await ctx.session.list(cursor ? { cursor } : { directory: ctx.location.directory });
        for (const session of page.data) if (internal(session) && session.time.created < processStartedAt && await realpath(session.location.directory) === await realpath(ctx.location.directory)) { await ctx.session.remove({ sessionID: session.id }); removed++; }
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      return removed;
    };
    const pendingPermissions = async () => {
      await readManagedEngineSettings(settingsPath, ctx.location.directory);
      const requests: LegalMemoryPermission[] = [];
      for (const [operationID, call] of operations) {
        for (const request of await ctx.permission.list({ sessionID: call.sessionID })) {
          if (request.source?.type !== "tool" || request.source.id !== call.id || request.source.messageID !== call.messageID) continue;
          requests.push({ operationID, requestID: request.id, action: request.action, resources: request.resources, ...(request.message ? { message: request.message } : {}) });
        }
      }
      return { requests };
    };
    const rpc = await ctx.rpc.register(legalMemoryRpc, { permissions: pendingPermissions, reply: async raw => {
      const input = LegalMemoryPermissionReplySchema.parse(raw);
      const call = operations.get(input.operationID);
      const pending = (await pendingPermissions()).requests.find(request => request.operationID === input.operationID && request.requestID === input.requestID);
      if (!call || !pending || call.signal.aborted) return { replied: false };
      if (input.decision === "reject") deniedSources.add(call.id);
      await ctx.permission.reply({ sessionID: call.sessionID, requestID: pending.requestID, decision: input.decision });
      return { replied: true };
    }, cleanup: async () => { await readManagedEngineSettings(settingsPath, ctx.location.directory); return { removed: await (cleanupPromise ??= cleanupOrphans()) }; }, servers: async () => {
      await readManagedEngineSettings(settingsPath, ctx.location.directory);
      await ctx.mcp.list();
      await (cleanupPromise ??= cleanupOrphans());
      return { names: Array.from(definitions).filter(([name, config]) => /^(?:legal[_-]?memory|knowledge[_-]?index)$/i.test(name) && config.type === "remote" && !config.disabled).map(([name]) => name) };
    }, request: async (raw, invocation): Promise<LegalMemoryResponse> => {
      const input = legalMemoryRequestSchema.parse(raw);
      const operationID = randomUUID();
      let created: Awaited<ReturnType<typeof ctx.session.create>> | undefined;
      try {
        invocation.signal.throwIfAborted();
        await readManagedEngineSettings(settingsPath, ctx.location.directory);
        const config = safeRemote(definitions.get(input.serverName), input);
        const status = (await ctx.mcp.list()).data.find(server => server.name === input.serverName);
        if (!status || status.status.status === "disabled") throw new LegalMemoryAccessError("not_configured", "LegalMemory is not enabled for this project.");
        await (cleanupPromise ??= cleanupOrphans());
        const agents = (await ctx.agent.list()).data;
        const agent = agents.find(agent => agent.id === "legalwork") ?? agents.find(agent => agent.id === "build") ?? agents.find(agent => agent.mode !== "subagent");
        if (!agent) throw new LegalMemoryAccessError("not_configured", "No native context is available for this LegalMemory read.");
        created = await ctx.session.create({ agent: agent.id, title: "LegalMemory interface read", metadata: { legalworkInternal: LEGALMEMORY_INTERNAL_SESSION },
          permissions: [{ action: "*", resource: "*", effect: "deny" }, ...legalMemoryReadTools.map(name => ({ action: action(input.serverName, name), resource: "*", effect: "allow" as const }))] });
        if (await realpath(created.location.directory) !== await realpath(ctx.location.directory)) throw new LegalMemoryAccessError("not_configured", "LegalMemory execution belongs to a different project.");
        const message = await ctx.session.synthetic({ sessionID: created.id, text: "The user requested a read-only LegalMemory interface operation.", resume: false, metadata: { legalworkInternal: LEGALMEMORY_INTERNAL_SESSION } });
        const call: ToolContext = { sessionID: Session.ID.make(created.id), agent: Agent.ID.make(agent.id), messageID: SessionMessage.ID.make(message.id),
          id: Tool.CallID.make(`call_${randomUUID().replaceAll("-", "")}`), signal: invocation.signal, progress: async () => {} };
        operations.set(operationID, call);
        const native = (name: string, args: Record<string, unknown>) => executeNative(ctx, call, input.serverName, name, args);
        const resolveBearer = async () => {
          if (config.oauth === false || !status.integrationID) return undefined;
          const connection = await ctx.integration.connection.active(status.integrationID);
          const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
          return credential?.type === "oauth" ? { access: credential.access, expired: credential.expires > 0 && credential.expires <= Date.now() } : undefined;
        };
        let refreshed = false;
        const refresh = async (signal: AbortSignal) => { if (refreshed) return; refreshed = true; await executeNative(ctx, { ...call, signal }, input.serverName, "list_connectors", {}); };
        const headers = async (signal: AbortSignal) => {
          let bearer = await resolveBearer();
          if (bearer?.expired && !refreshed) { await refresh(signal); bearer = await resolveBearer(); }
          return new Headers({ ...(config.headers ?? {}), ...(bearer ? { Authorization: `Bearer ${bearer.access}` } : {}) });
        };
        const request = async (url: string, init: RequestInit = {}, signal = invocation.signal) => {
          const send = async () => {
            signal.throwIfAborted();
            const auth = await headers(signal);
            signal.throwIfAborted(); new Headers(init.headers).forEach((value, name) => auth.set(name, value));
            return fetch(url, { ...init, headers: auth, redirect: "error", signal });
          };
          let response = await send();
          if (response.status === 401 && !refreshed) { await response.body?.cancel(); await refresh(signal); response = await send(); }
          return response;
        };
        let value: unknown;
        if (input.operation.type === "tree") {
          await assertRead(ctx, call, action(input.serverName, "list_connectors"));
          const allowed = input.operation.name === "roots" ? [] : input.operation.name === "children" ? ["source_id", "path", "offset", "limit"] : ["query", "limit"];
          if (Object.keys(input.operation.params).some(key => !allowed.includes(key))) throw new LegalMemoryAccessError("tree_unavailable", "Unsupported LegalMemory tree parameters.");
          let loaded = false;
          for (const target of [legalMemoryTreeProxyUrl(config.url, input.operation.name), legalMemoryTreeApiUrl(config.url, `/api/tree/${input.operation.name}`)]) {
            const url = new URL(target);
            for (const [key, value] of Object.entries(input.operation.params)) url.searchParams.set(key, String(value));
            const response = await request(url.href, { headers: { accept: "application/json" } });
            if (response.ok) { value = await response.json(); loaded = true; break; }
            await response.body?.cancel();
          }
          if (!loaded) throw new LegalMemoryAccessError("tree_unavailable", "This LegalMemory deployment does not expose the requested tree HTTP operation; its MCP fallback can still be used.");
        } else if (input.operation.name === "download_document") {
          // Only this existing binary-preserving operation uses a small HTTP
          // protocol adapter. Native lowering discards binary filename/provenance.
          await assertRead(ctx, call, action(input.serverName, input.operation.name));
          const download = z.object({ document_id: z.string().min(1), version_id: z.string().optional(), inline_blob: z.boolean() }).strict().parse(input.operation.args);
          // Preserve explicit native per-stage settings. This compatibility
          // path historically had no default deadline; do not add one silently.
          const stageSignal = (timeout: number | undefined) => timeout === undefined ? invocation.signal : AbortSignal.any([invocation.signal, AbortSignal.timeout(timeout)]);
          const startupSignal = stageSignal(config.timeout?.startup);
          let mcpSession: string | undefined, protocolVersion: string | undefined;
          const invoke = async (method: string, params: unknown, id?: number) => {
            const response = await request(config.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(mcpSession ? { "mcp-session-id": mcpSession } : {}), ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}) },
              body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) }, method === "tools/call" ? stageSignal(config.timeout?.execution) : startupSignal);
            mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
            if (!response.ok) throw new LegalMemoryAccessError("request_failed", `LegalMemory download failed (${response.status}).`);
            if (id === undefined) { await response.body?.cancel(); return null; }
            return parseRpc(response, id);
          };
          try {
            const initialized = await invoke("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "LegalWork", version: "2" } }, 1);
            const negotiated = z.object({ result: z.object({ protocolVersion: z.string() }) }).parse(initialized);
            protocolVersion = negotiated.result.protocolVersion;
            await invoke("notifications/initialized", {});
            value = await invoke("tools/call", { name: "download_document", arguments: download }, 2);
          } finally {
            if (mcpSession && !invocation.signal.aborted) {
              try { const response = await request(config.url, { method: "DELETE", headers: { "mcp-session-id": mcpSession, ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}) } }); await response.body?.cancel(); }
              catch { /* Best-effort protocol cleanup cannot replace a completed download. */ }
            }
          }
        } else value = nativeEnvelope(await native(input.operation.name, input.operation.args));
        invocation.signal.throwIfAborted();
        return legalMemoryResponseSchema.parse({ ok: true, value });
      } catch (error) {
        if (invocation.signal.aborted) return { ok: false, code: "cancelled", message: "LegalMemory request was cancelled." };
        const denied = operations.get(operationID);
        if (denied && deniedSources.has(denied.id)) return { ok: false, code: "permission_denied", message: "LegalMemory read access was denied." };
        if (error instanceof DOMException && error.name === "TimeoutError") return { ok: false, code: "request_failed", message: "LegalMemory exceeded this connection’s explicitly configured stage timeout." };
        if (error instanceof LegalMemoryAccessError) return { ok: false, code: error.code, message: error.message };
        return { ok: false, code: "request_failed", message: "LegalMemory could not complete this read. Check the connection and its native sign-in status." };
      } finally { const call = operations.get(operationID); if (call) deniedSources.delete(call.id); operations.delete(operationID); if (created) await ctx.session.remove({ sessionID: created.id }); }
    } });
    return async () => { await rpc.dispose(); await transform.dispose(); await permissionObserver.dispose(); };
  },
});
