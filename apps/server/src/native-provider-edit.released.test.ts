import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeNativeProjectProjection } from "./engine-project.js";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

test.skipIf(!nativeMcpBinary)("released native ownership keeps public config/status private while targeted edits and hidden-endpoint discovery preserve private values", async () => {
  const previous = { ...process.env };
  const marker = "synthetic-config-private-key", header = "synthetic-config-private-header", authored = "synthetic-authored-private-key";
  const discovered: Array<{ path: string; authorization: string | null }> = [];
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { discovered.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") }); return Response.json({ data: [{ id: "kept" }] }); } });
  let setup: { config: ServerConfig; source: string; original: string; projection: string } | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    engine = await nativeMcpEngine(async root => {
      const directory = join(root, "project");
      process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
      process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
      process.env.XDG_CONFIG_HOME = join(root, "private-config");
      const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic-client", hostToken: "synthetic-host",
        approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }],
        engineProjectTrustRequired: true, authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
      // The trusted legacy raw view chooses JSONC first. Keep that authored
      // document distinct from LegalWork's generated native JSON projection.
      const source = join(directory, "opencode.jsonc");
      const original = JSON.stringify({ providers: { authored: { settings: { apiKey: authored } } } });
      await writeFile(source, original);
      const owned = { providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", name: "Fixture",
        settings: { baseURL: `${endpoint.url.origin}/v1`, apiKey: marker }, headers: { "x-private-auth": header }, models: { kept: { name: "Before", limit: { context: 32000 }, settings: { apiKey: marker } } },
      } } };
      await writeRuntimeOpencodeConfig(config, "matter", () => owned);
      setup = { config, source, original, projection: await writeNativeProjectProjection(config, config.workspaces[0]!, owned) };
      return {};
    });
    if (!setup) throw new Error("Native provider edit fixture setup did not finish");
    const { config, source, original, projection } = setup, connection = engine.connection();
    expect(projection).not.toBe(source);
    config.opencodeBaseUrl = connection.url; config.opencodeUsername = connection.username; config.opencodePassword = connection.password;
    server = await startServer(config);
    const entries = await engine.client().config.get({ location: engine.location });
    expect(entries.some(entry => entry.type === "document" && entry.path === projection && entry.info.providers?.fixture?.name === "Fixture")).toBe(true);
    const base = `http://127.0.0.1:${server.port}/workspace/matter`;
    const headers = { Authorization: `Bearer ${config.token}`, "content-type": "application/json" };
    const response = await fetch(`${base}/config`, { headers }); expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.authoredConfig.status).toBe("resolved");
    for (const value of [marker, header, authored, endpoint.url.origin]) expect(JSON.stringify(view)).not.toContain(value);
    expect(view.providerDisplay.fixture).toEqual({ hasCustomEndpoint: true, editable: true });
    expect(view.providerDisplay.authored).toEqual({ hasCustomEndpoint: false, editable: false });
    expect(view.opencode.$legalworkReadOnlyProjection).toBe(true);
    const status = await fetch(`${base}/runtime-config`, { headers }); expect(status.status).toBe(200);
    const statusText = await status.text();
    for (const value of [marker, header, authored, endpoint.url.origin]) expect(statusText).not.toContain(value);
    expect(statusText).toContain("runtimeKeys"); expect(statusText).toContain("projectOpencode");
    const roundtrip = await fetch(`${base}/config`, { method: "PATCH", headers, body: JSON.stringify({ opencode: view.opencode }) });
    expect(roundtrip.status).toBe(400); expect((await roundtrip.json()).code).toBe("read_only_configuration_projection");
    const patch = await fetch(`${base}/config`, { method: "PATCH", headers, body: JSON.stringify({ opencode: { providers: { fixture: { name: "Renamed", settings: {}, models: { kept: { name: "After", limit: null } } } } } }) });
    expect(patch.status).toBe(200);
    const saved = await readRuntimeOpencodeConfig(config, "matter");
    expect(saved.providers).toMatchObject({ fixture: { name: "Renamed", settings: { baseURL: `${endpoint.url.origin}/v1`, apiKey: marker }, headers: { "x-private-auth": header }, models: { kept: { name: "After", settings: { apiKey: marker } } } } });
    expect(saved.providers).not.toHaveProperty("fixture.models.kept.limit");
    const discovery = await fetch(`${base}/provider-models`, { method: "POST", headers, body: JSON.stringify({ providerId: "fixture", apiKey: "synthetic-new-preview-key" }) });
    expect(discovery.status).toBe(200); expect(await discovery.json()).toEqual({ models: ["kept"] });
    expect(discovered).toEqual([{ path: "/v1/models", authorization: "Bearer synthetic-new-preview-key" }]);
    for (const method of ["GET", "POST"]) {
      const raw = await fetch(`${base}/opencode-config`, { method, headers, ...(method === "POST" ? { body: JSON.stringify({ content: "{}" }) } : {}) });
      expect(raw.status).toBe(401);
    }
    const trusted = await fetch(`${base}/opencode-config`, { headers: { "x-legalwork-host-token": config.hostToken } });
    expect(trusted.status).toBe(200); expect((await trusted.json()).content).toContain(authored);
    expect(await readFile(source, "utf8")).toBe(original);
    expect(await engine.client().session.active()).toEqual({});
  } finally {
    await server?.stop(); await engine?.close(); endpoint.stop(true);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}, 30_000);
