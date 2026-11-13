import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeNativeProjectProjection } from "./engine-project.js";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { startServer } from "./server.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

test.skipIf(!nativeMcpBinary)("native config loads without project approval and public reads redact expanded secrets", async () => {
  const previous = { ...process.env };
  let setup: { config: ServerConfig; source: string; original: string; effectPath: string; secretPath: string } | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    engine = await nativeMcpEngine(async root => {
      process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
      process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
      const directory = join(root, "project"), source = join(directory, "opencode.jsonc");
      const effectPath = join(root, "private-effect.txt"), secretPath = join(root, "private-key.txt");
      await writeFile(effectPath, "ask");
      await writeFile(secretPath, "synthetic-private-provider-key");
      const original = `// Preserve authored JSONC and native macro semantics.\n${JSON.stringify({
        permissions: [{ action: "read", resource: "*", effect: `{file:${effectPath}}` }],
        providers: { authored: { name: "Authored native provider", settings: { apiKey: `{file:${secretPath}}`, baseURL: "https://synthetic-private-endpoint.invalid/v1" } } },
      }, null, 2)}\n`;
      await writeFile(source, original);
      const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture-config-reader", hostToken: "fixture-config-host", configPath: join(root, "server.json"),
        workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [directory], engineProjectTrustRequired: true,
        readOnly: true, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
      const owned = { providers: { owned: { name: "Saved app provider", settings: { baseURL: "https://synthetic-owned.invalid/v1", apiKey: "synthetic-owned-key" } } } };
      await writeRuntimeOpencodeConfig(config, "matter", () => owned);
      await writeNativeProjectProjection(config, config.workspaces[0]!, owned);
      setup = { config, source, original, effectPath, secretPath };
      return {};
    });
    if (!setup) throw new Error("Native config fixture setup did not finish");
    const { config, source, original, effectPath, secretPath } = setup, connection = engine.connection();
    config.opencodeBaseUrl = connection.url; config.opencodeUsername = connection.username; config.opencodePassword = connection.password;
    server = await startServer(config);
    const read = (path = "config") => fetch(`http://127.0.0.1:${server!.port}/workspace/matter/${path}`, { headers: { authorization: `Bearer ${config.token}` } });
    const after = await read(); expect(after.status).toBe(200);
    const ready: unknown = await after.json();
    expect(ready).toMatchObject({ authoredConfig: { status: "resolved", paths: [source] },
      opencode: { permissions: [{ action: "read", resource: "*", effect: "ask" }], providers: { authored: { name: "Authored native provider" }, owned: { name: "Saved app provider" } } },
      providerDisplay: { authored: { hasCustomEndpoint: true, editable: false }, owned: { hasCustomEndpoint: true, editable: true } } });
    for (const privateValue of [effectPath, secretPath, "synthetic-private-provider-key", "synthetic-owned-key", "synthetic-private-endpoint", "synthetic-owned.invalid"]) expect(JSON.stringify(ready)).not.toContain(privateValue);
    // Positive control: the released loader, rather than our view, expanded it.
    expect(JSON.stringify(await engine.client().config.get({ location: engine.location }))).toContain("synthetic-private-provider-key");
    const readyDiagnostic = await read("runtime-config"); expect(readyDiagnostic.status).toBe(200);
    const readySources: unknown = await readyDiagnostic.json();
    expect(readySources).toMatchObject({ sources: { projectOpencode: { status: "resolved", config: { permissions: [{ action: "read", resource: "*", effect: "ask" }] } } } });
    for (const privateValue of [effectPath, secretPath, "synthetic-private-provider-key", "synthetic-owned-key"]) expect(JSON.stringify(readySources)).not.toContain(privateValue);
    expect(await readFile(source, "utf8")).toBe(original);
    config.opencodeBaseUrl = undefined;
    const offline = await read(); expect(offline.status).toBe(200);
    expect(await offline.json()).toMatchObject({ authoredConfig: { status: "unavailable", paths: [source] }, opencode: { providers: { owned: { name: "Saved app provider" } } } });
    expect(await engine.client().session.active()).toEqual({});
  } finally {
    await server?.stop(); await engine?.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}, 30_000);
