import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Client, isInitializeRequest, isJSONRPCRequest, isJSONRPCNotification, isJSONRPCResultResponse, isJSONRPCErrorResponse } from "@modelcontextprotocol/client";
import { Server, WebStandardStreamableHTTPServerTransport, isLegacyRequest, type ServerContext } from "@modelcontextprotocol/server";
import { ResultSchema, ElicitResultSchema, CreateMessageResultWithToolsSchema, ListRootsResultSchema } from "@modelcontextprotocol/core";
import { ApiError } from "./errors.js";
import type { McpConnectorManager } from "./mcp-manager.js";

type PendingResponse = { done: Promise<void>; finish: () => void };
type GatewaySession = { connectionId: string; workspaceId: string; server: Server; transport: WebStandardStreamableHTTPServerTransport; lastUsed: number; responses: Map<string | number, PendingResponse> };

/** Sessions belong to an engine's workspace. Upstream credentials and refresh
 * coordination belong exclusively to the connector manager. */
export class LocalMcpGateway {
  private sessions = new Map<string, GatewaySession>();
  private unregister: () => void;
  constructor(private manager: McpConnectorManager) {
    const stopRetire = manager.onRetire(async id => {
      await Promise.allSettled(Array.from(this.sessions, async ([sessionId, session]) => {
        if (session.connectionId !== id) return;
        this.sessions.delete(sessionId);
        await Promise.allSettled(Array.from(session.responses.values(), response => response.done));
        await session.server.close();
      }));
    });
    this.unregister = stopRetire;
  }

  async handle(request: Request, workspaceId: string, connectionId: string): Promise<Response> {
    if (!this.manager.authorize(request, workspaceId, connectionId)) return Response.json({ error: "unauthorized" }, { status: 401 });
    // Revalidate registry membership, enabled state and organization policy on
    // every request, including requests carrying an established MCP session.
    const record = await this.manager.gatewayConnection(workspaceId, connectionId);
    if (record.config.enabled === false) return Response.json({ error: "connection_disabled" }, { status: 503 });
    // Modern MCP is stateless. Preserve its envelopes, interactive rounds,
    // tasks and subscription streams without translating or filtering payloads.
    // Legacy clients below use the SDK's dual-era client as a protocol bridge.
    if (!await isLegacyRequest(request.clone())) return this.manager.forwardModern(request, record);
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = this.sessions.get(id);
      if (!session || session.connectionId !== connectionId || session.workspaceId !== workspaceId) return Response.json({ error: "session_not_found" }, { status: 404 });
      session.lastUsed = Date.now();
      const body: unknown = request.method === "POST" ? await request.clone().json().catch(() => null) : undefined;
      if (isJSONRPCNotification(body) && body.method === "notifications/cancelled") {
        const requestId = body.params?.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") session.responses.get(requestId)?.finish();
      }
      if (isJSONRPCRequest(body)) {
        const id = body.id;
        let resolve: () => void = () => {};
        const done = new Promise<void>(finish => { resolve = finish; });
        const finish = () => { session.responses.delete(id); request.signal.removeEventListener("abort", finish); resolve(); };
        session.responses.set(id, { done, finish });
        request.signal.addEventListener("abort", finish, { once: true });
      }
      try {
        const response = await session.transport.handleRequest(request, { parsedBody: body });
        if (response.status >= 400 && isJSONRPCRequest(body)) session.responses.get(body.id)?.finish();
        return response;
      } catch (error) {
        if (isJSONRPCRequest(body)) session.responses.get(body.id)?.finish();
        throw error;
      }
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const body: unknown = await request.clone().json().catch(() => null);
    if (!isInitializeRequest(body)) return Response.json({ error: "initialize_required" }, { status: 400 });
    for (const [sessionId, session] of this.sessions) {
      if (Date.now() - session.lastUsed < 30 * 60_000 || session.responses.size) continue;
      this.sessions.delete(sessionId);
      await session.server.close();
    }
    if (this.sessions.size >= 256) throw new ApiError(429, "mcp_session_limit", "Too many active connector sessions.");
    const capabilities = body.params.capabilities;
    const requests = new AsyncLocalStorage<ServerContext>();
    let server: Server | undefined;
    let activeClient: Client | undefined;
    let connecting: Promise<Client> | undefined;
    const prepare = (client: Client) => {
      if (capabilities.elicitation) client.setRequestHandler("elicitation/create", (message, ctx) => {
        if (!server) throw new ApiError(503, "mcp_initializing", "The connector is initializing.");
        const related = requests.getStore()?.mcpReq;
        return related ? related.send(message, ElicitResultSchema, { signal: ctx.mcpReq.signal }) : server.request(message, ElicitResultSchema, { signal: ctx.mcpReq.signal });
      });
      if (capabilities.sampling) client.setRequestHandler("sampling/createMessage", (message, ctx) => {
        if (!server) throw new ApiError(503, "mcp_initializing", "The connector is initializing.");
        const related = requests.getStore()?.mcpReq;
        return related ? related.send(message, CreateMessageResultWithToolsSchema, { signal: ctx.mcpReq.signal }) : server.request(message, CreateMessageResultWithToolsSchema, { signal: ctx.mcpReq.signal });
      });
      if (capabilities.roots) client.setRequestHandler("roots/list", (message, ctx) => {
        if (!server) throw new ApiError(503, "mcp_initializing", "The connector is initializing.");
        const related = requests.getStore()?.mcpReq;
        return related ? related.send(message, ListRootsResultSchema, { signal: ctx.mcpReq.signal }) : server.request(message, ListRootsResultSchema, { signal: ctx.mcpReq.signal });
      });
      client.fallbackRequestHandler = (message, ctx) => {
        if (!server) throw new ApiError(503, "mcp_initializing", "The connector is initializing.");
        const related = requests.getStore()?.mcpReq;
        return related ? related.send(message, ResultSchema, { signal: ctx.mcpReq.signal }) : server.request(message, ResultSchema, { signal: ctx.mcpReq.signal });
      };
      client.fallbackNotificationHandler = async message => { await server?.notification(message); };
    };
    const upstreamClient = async () => {
      if (activeClient?.transport) return activeClient;
      connecting ??= this.manager.client(record, { capabilities, prepare });
      try { activeClient = await connecting; return activeClient; }
      finally { connecting = undefined; }
    };
    const client = await upstreamClient();
    const downstream = new Server({ name: "LegalWork MCP Gateway", version: "1.0.0" }, {
      capabilities: client.getServerCapabilities(),
      ...(client.getInstructions() ? { instructions: client.getInstructions() } : {}),
    });
    server = downstream;
    // A client is private to this downstream session. Server-initiated requests
    // and MRTR fulfilment cannot leak into another workspace's conversation.
    downstream.fallbackRequestHandler = (message, ctx) => requests.run(ctx, async () => {
      const progressToken = message.params?._meta?.progressToken;
      return (await upstreamClient()).request(message, ResultSchema, {
        signal: ctx.mcpReq.signal, timeout: record.config.timeout ?? 60_000,
        ...(progressToken === undefined ? {} : { onprogress: progress => {
          void ctx.mcpReq.notify({ method: "notifications/progress", params: { ...progress, progressToken } }).catch(() => {});
        } }),
      });
    });
    downstream.fallbackNotificationHandler = async message => {
      const upstream = await upstreamClient();
      // Roots changed is a legacy notification. Modern roots are requested
      // afresh by each MRTR round and have no push-notification counterpart.
      if (message.method === "notifications/roots/list_changed" && upstream.getProtocolEra() === "modern") return;
      await upstream.notification(message);
    };
    const responses = new Map<string | number, PendingResponse>();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: false,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${this.manager.config.port}`, `localhost:${this.manager.config.port}`],
      onsessioninitialized: sessionId => { this.sessions.set(sessionId, { connectionId, workspaceId, server: downstream, transport, lastUsed: Date.now(), responses }); },
      onsessionclosed: sessionId => { this.sessions.delete(sessionId); void downstream.close(); },
    });
    // Drain actual protocol responses, rather than the HTTP Response object,
    // which is returned before an SSE tool operation finishes.
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try { await send(message, options); }
      finally {
        if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined) {
          responses.get(message.id)?.finish();
        }
      }
    };
    await downstream.connect(transport);
    const close = downstream.onclose;
    downstream.onclose = () => { close?.(); void activeClient?.close(); };
    try { return await transport.handleRequest(request, { parsedBody: body }); }
    catch (error) { await downstream.close(); await activeClient?.close(); throw error; }
  }

  async close() {
    this.unregister();
    await Promise.allSettled(Array.from(this.sessions.values(), session => session.server.close()));
    this.sessions.clear();
  }
}
