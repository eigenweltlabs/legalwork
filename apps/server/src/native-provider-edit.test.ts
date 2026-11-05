import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePrivateProviderEdits } from "./native-provider-edit.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

test("specific provider edits preserve omitted transport values while explicit removal and model inventory changes still work", () => {
  const saved = { fixture: { package: "@opencode/ai/providers/openai-compatible", name: "Before",
    settings: { baseURL: "https://private-endpoint.example/v1", apiKey: "synthetic-private-key" }, headers: { "x-auth": "synthetic-header" }, body: { custom_auth: "synthetic-body" },
    models: { keep: { limit: { context: 32000 }, settings: { apiKey: "synthetic-model-key" }, headers: { "x-model-auth": "synthetic-model-header" }, variants: [{ id: "private", headers: { "x-variant": "synthetic-variant" } }] }, remove: { name: "Retired" } },
  } };
  const result = mergePrivateProviderEdits(saved, { fixture: { name: "After", settings: {}, models: { keep: { name: "Kept", limit: null } } } });
  expect(result).toMatchObject({ fixture: { name: "After", settings: saved.fixture.settings, headers: saved.fixture.headers, body: saved.fixture.body,
    models: { keep: { name: "Kept", settings: saved.fixture.models.keep.settings, headers: saved.fixture.models.keep.headers, variants: saved.fixture.models.keep.variants } } } });
  expect(result).not.toHaveProperty("fixture.models.keep.limit");
  expect(result).not.toHaveProperty("fixture.models.remove");
  const removed = mergePrivateProviderEdits(result, { fixture: { settings: { apiKey: null }, headers: null } });
  expect(removed).not.toHaveProperty("fixture.settings.apiKey");
  expect(removed).not.toHaveProperty("fixture.headers");
  expect(mergePrivateProviderEdits(removed, { fixture: null })).toEqual({});
  expect(saved.fixture.models.keep.limit).toEqual({ context: 32000 });
});

test.each([false, true])("offline settings retain private values and distinguish managed ownership from native provenance (managed=%s)", async managed => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-private-provider-offline-")));
  const directory = join(root, "project"); await mkdir(directory);
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "private-config");
  const marker = "synthetic-config-private-key", header = "synthetic-config-private-header", authored = "synthetic-authored-private-key";
  const endpoint = "https://synthetic-private-endpoint.invalid/v1";
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic-client", hostToken: "synthetic-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }],
    authorizedRoots: [directory], ...(managed ? { engineConfigurationMode: "managed" } : {}),
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const source = join(directory, "opencode.json");
  await writeFile(source, JSON.stringify({ providers: { authored: { settings: { apiKey: authored } } } }));
  await writeRuntimeOpencodeConfig(config, "matter", () => ({ providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", name: "Fixture",
    settings: { baseURL: endpoint, apiKey: marker }, headers: { "x-private-auth": header }, models: { kept: { name: "Before", settings: { apiKey: marker } } },
  } } }));
  const server = await startServer(config);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/matter/config`, { headers: { Authorization: `Bearer ${config.token}` } });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.authoredConfig).toEqual({ status: "unavailable", paths: managed ? [] : [source] });
    expect(view.opencode.$legalworkReadOnlyProjection).toBe(true);
    expect(view.providerDisplay.fixture).toEqual({ hasCustomEndpoint: true, editable: managed });
    expect(view.providerDisplay).not.toHaveProperty("authored");
    expect(view.opencode.providers).not.toHaveProperty("authored");
    for (const value of [marker, header, authored, endpoint]) expect(JSON.stringify(view)).not.toContain(value);
    if (managed) {
      const diagnostics = await fetch(`http://127.0.0.1:${server.port}/workspace/matter/runtime-config`, { headers: { Authorization: `Bearer ${config.token}` } });
      expect(diagnostics.status).toBe(200);
      expect(await diagnostics.json()).toMatchObject({ sources: { projectOpencode: { status: "not_loaded" } } });
      const native = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/api/config"
        ? Response.json([{ type: "document", info: { providers: { shared: { name: "Shared provider", settings: { apiKey: marker } } } } }])
        : new Response("Unexpected native route", { status: 500 }) });
      try {
        config.opencodeBaseUrl = native.url.origin;
        const connected = await fetch(`http://127.0.0.1:${server.port}/workspace/matter/config`, { headers: { Authorization: `Bearer ${config.token}` } });
        expect(connected.status).toBe(200);
        const current = await connected.json();
        expect(current.authoredConfig).toEqual({ status: "resolved", paths: [] });
        expect(current.opencode.providers).toMatchObject({ shared: { name: "Shared provider" }, fixture: { name: "Fixture" } });
        expect(current.providerDisplay.fixture).toEqual({ hasCustomEndpoint: true, editable: true });
        expect(current.providerDisplay.shared.editable).toBe(false);
        for (const value of [marker, header, authored, endpoint]) expect(JSON.stringify(current)).not.toContain(value);
      } finally { native.stop(true); }
    }
  } finally {
    await server.stop(); await rm(root, { recursive: true, force: true });
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
});
