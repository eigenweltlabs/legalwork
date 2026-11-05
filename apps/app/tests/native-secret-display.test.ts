import { expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { readConfiguredMcpServers } from "../src/react-app/domains/connections/native-mcp";
import type { ConnectorDisplayItem } from "@legalwork/types/connector-config";

test("mounted connector settings read selected LegalWork metadata without reading native executable definitions", async () => {
  const requests: Array<{ path: string; auth: string | null }> = [];
  const item: ConnectorDisplayItem = { name: "private-local", source: "config.remote", editable: true, config: { type: "local", enabled: true },
    configured: { url: false, command: true, cwd: true, headers: [], environment: ["PRIVATE_TOKEN"], oauth: false, variables: [] } };
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, auth: request.headers.get("authorization") });
    return path === "/workspace/selected/mcp" ? Response.json({ items: [item] }) : new Response("Executable definition read forbidden", { status: 403 });
  } });
  try {
    const client = createClient(`${server.url.origin}/workspace/selected/opencode`, "/selected/project", { mode: "legalwork", token: "synthetic-selected-token" });
    expect(await readConfiguredMcpServers(client, "/selected/project")).toEqual([item]);
    expect(requests).toEqual([{ path: "/workspace/selected/mcp", auth: "Bearer synthetic-selected-token" }]);
  } finally { server.stop(true); }
});

test("raw config editor methods require host access while typed edits submit only explicit replacements", async () => {
  const requests: Array<{ path: string; host: string | null; body: unknown }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, host: request.headers.get("x-legalwork-host-token"), body: request.method === "POST" ? await request.json() : null });
    return Response.json({ items: [] });
  } });
  try {
    const untrusted = createLegalworkServerClient({ baseUrl: server.url.origin, token: "synthetic-client" });
    await expect(untrusted.readOpencodeConfigFile("selected")).rejects.toThrow("trusted host access");
    await expect(untrusted.writeOpencodeConfigFile("selected", "project", "{}")).rejects.toThrow("trusted host access");
    expect(requests).toEqual([]);
    await untrusted.addMcp("selected", { name: "private-local", config: { type: "local", enabled: true }, preserveScope: true,
      executable: "new-executable", arguments: ["--new-flag"], removeEnvironment: ["OLD_TOKEN"], removeHeaders: ["Old-Authorization"], resetFields: ["cwd"], variables: { TOKEN: "synthetic-new-token" } });
    expect(requests[0]?.body).toEqual({ name: "private-local", config: { type: "local", enabled: true }, preserveScope: true,
      executable: "new-executable", arguments: ["--new-flag"], removeEnvironment: ["OLD_TOKEN"], removeHeaders: ["Old-Authorization"], resetFields: ["cwd"], variables: { TOKEN: "synthetic-new-token" } });
    const trusted = createLegalworkServerClient({ baseUrl: server.url.origin, token: "synthetic-client", hostToken: "synthetic-host" });
    await trusted.readOpencodeConfigFile("selected");
    expect(requests[1]?.host).toBe("synthetic-host");
  } finally { server.stop(true); }
});
