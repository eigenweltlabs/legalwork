import { OpenCode, type IntegrationInfo, type ProviderInfo } from "@opencode/client";

export function nativeProviderFixture(input: { failMethods?: boolean; onReload?: () => void; connected?: Set<string>; activeSessions?: string[] } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const connected = input.connected ?? new Set<string>();
  const location = { directory: "/preview", projectID: "preview" };
  const integrations: IntegrationInfo[] = [
    { id: "openai", name: "OpenAI", connections: [], methods: [{ type: "key", label: "API key" }, { type: "oauth", id: "device", label: "ChatGPT device" }, { type: "oauth", id: "browser", label: "ChatGPT browser" }] },
    { id: "google", name: "Google", connections: [], methods: [{ type: "oauth", id: "google-login", label: "Google sign-in", form: [{ type: "string", key: "account", title: "Account", required: true }] }] },
    { id: "anthropic", name: "Anthropic", connections: [], methods: [{ type: "key", label: "API key" }] },
    { id: "command", name: "Command", connections: [], methods: [{ type: "command", id: "command-login", label: "Local sign-in", command: ["synthetic-sign-in"] }] },
    { id: "external", name: "External", connections: [], methods: [{ type: "external", id: "external-login", label: "External sign-in", form: [{ type: "boolean", key: "approved", title: "Approved", required: true }] }] },
  ];
  const states = new Map<string, "pending" | "complete" | "expired">();
  let sequence = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body: unknown = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json().catch(() => undefined);
    calls.push({ method: request.method, path, body });
    if (path === "/api/info") return Response.json({ version: "2.1.4", pid: process.pid });
    if (path === "/api/session/active") return Response.json({data:Object.fromEntries((input.activeSessions ?? []).map(id=>[id,{type:"running"}]))});
    if (path === "/api/location/reload") { input.onReload?.(); return new Response(null, { status: 204 }); }
    if (path === "/api/config") return Response.json([]);
    if (path === "/api/provider") {
      const data: ProviderInfo[] = [...connected].map(id => ({ id, name: id, integrationID: id, activation: "auto", package: "@opencode/ai/providers/openai-compatible" }));
      return Response.json({ location, data });
    }
    if (path === "/api/model") return Response.json({ location, data: [] });
    if (path === "/api/model/default") return Response.json({ location, data: null });
    if (path === "/api/mcp") return Response.json({ location, data: [] });
    if (path === "/api/integration") return input.failMethods ? Response.json({ message: "Unavailable" }, { status: 503 }) : Response.json({ location, data: integrations });
    const key = path.match(/^\/api\/integration\/([^/]+)\/connect\/(key|external)$/);
    if (key) { connected.add(key[1]); return new Response(null, { status: 204 }); }
    const start = path.match(/^\/api\/integration\/([^/]+)\/connect\/(oauth|command)$/);
    if (start) {
      const attemptID = `attempt-${++sequence}`;
      states.set(attemptID, "pending");
      return Response.json({ location, data: { attemptID, ...(start[2] === "oauth" ? { url: "https://auth.example.test/authorize", instructions: "Native sign-in", mode: "auto" } : {}), time: { created: Date.now(), expires: Date.now() + 600_000 } } });
    }
    const status = path.match(/^\/api\/integration\/([^/]+)\/connect\/(oauth|command)\/([^/]+)(\/complete)?$/);
    if (status) {
      if (request.method === "DELETE") { states.delete(status[3]); return new Response(null, { status: 204 }); }
      if (status[4]) { states.set(status[3], "complete"); connected.add(status[1]); return new Response(null, { status: 204 }); }
      const state = states.get(status[3]) ?? "expired";
      if (state === "complete") connected.add(status[1]);
      return Response.json({ location, data: { status: state, time: { created: Date.now(), expires: Date.now() + 600_000 } } });
    }
    return Response.json({ message: `Unexpected request ${request.method} ${path}` }, { status: 500 });
  } });
  const client = OpenCode.make({ baseUrl: server.url.toString().replace(/\/$/, "") });
  return { client, baseUrl: server.url.toString(), calls, connected, integrations, states, stop: () => server.stop(true) };
}
