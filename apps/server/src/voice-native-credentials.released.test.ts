import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

test.skipIf(!nativeMcpBinary)("Voice Mode follows the active native API key and never revives retired credentials", async () => {
  const previous = { ...process.env }, realFetch = globalThis.fetch;
  const engine = await nativeMcpEngine({});
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    delete process.env.OPENAI_API_KEY;
    const root = engine.root;
    process.env.LEGALWORK_ENV_STORE = join(root, "env.json");
    process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    process.env.XDG_DATA_HOME = join(root, "app-data");
    const legacy = join(process.env.XDG_DATA_HOME, "opencode");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "auth.json"), JSON.stringify({ openai: { type: "api", key: "synthetic-retired-key" } }));
    const connection = engine.connection();
    const config: ServerConfig = {
      configPath: join(root, "server.json"), host: "127.0.0.1", port: 0,
      token: "synthetic-client", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(),
      tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
      opencodeBaseUrl: connection.url, opencodeUsername: connection.username, opencodePassword: connection.password,
    };
    server = await startServer(config);
    const base = `http://127.0.0.1:${server.port}`, headers = { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" };
    const capability = async () => {
      const response = await fetch(`${base}/voice/realtime/capability`, { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    const call = () => fetch(`${base}/voice/realtime/call`, { method: "POST", headers, body: JSON.stringify({ sdp: "v=0\r\no=offer\r\n" }) });
    const restart = async () => {
      await engine.restart();
      const connection = engine.connection();
      config.opencodeBaseUrl = connection.url;
      config.opencodeUsername = connection.username;
      config.opencodePassword = connection.password;
    };
    await engine.client().model.list({ location: engine.location });
    expect((await capability()).supported).toBe(false);
    expect((await call()).status).toBe(409);

    const first = await engine.client().credential.create({ integrationID: "openai", value: { type: "key", key: "synthetic-first-key" }, activate: true });
    const second = await engine.client().credential.create({ integrationID: "openai", value: { type: "key", key: "synthetic-active-key" }, activate: true });
    process.env.OPENAI_API_KEY = "synthetic-environment-key";
    let requests = 0, activeKey = "synthetic-active-key";
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === "https://api.openai.com/v1/realtime/calls") {
        expect(request.headers.get("authorization")).toBe(`Bearer ${activeKey}`);
        requests++;
        return new Response("v=0\r\no=answer", { status: 200, headers: { "content-type": "application/sdp" } });
      }
      return realFetch(input, init);
    }, { preconnect: realFetch.preconnect });
    expect((await capability()).supported).toBe(true);
    expect((await call()).status).toBe(200);
    await restart();
    expect((await capability()).supported).toBe(true);
    expect((await call()).status).toBe(200);
    expect(requests).toBe(2);

    delete process.env.OPENAI_API_KEY;
    await engine.client().credential.remove({ credentialID: second.id });
    // The engine activates the remaining saved account when its active one is removed.
    expect((await engine.client().credential.list()).find(item => item.id === first.id)?.active).toBe(true);
    activeKey = "synthetic-first-key";
    expect((await call()).status).toBe(200);
    await engine.client().credential.remove({ credentialID: first.id });
    expect((await capability()).supported).toBe(false);
    expect((await call()).status).toBe(409);
    await restart();
    expect((await capability()).supported).toBe(false);
    expect((await call()).status).toBe(409);
    expect(requests).toBe(3);

    await engine.client().credential.create({ integrationID: "openai", value: { type: "oauth", methodID: "oauth", access: "synthetic-chatgpt-access", refresh: "synthetic-chatgpt-refresh", expires: Date.now() + 3600_000 }, activate: true });
    expect((await capability()).supported).toBe(false);
    expect((await call()).status).toBe(409);
  } finally {
    globalThis.fetch = realFetch;
    await server?.stop();
    await engine.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}, 45_000);
