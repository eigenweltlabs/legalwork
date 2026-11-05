import { expect, test } from "bun:test";
import { join } from "node:path";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { nativeProviderDisplay } from "./native-provider-display.js";
import { writeNativeProjectProjection } from "./engine-project.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

test.skipIf(!nativeMcpBinary)("released native provider order keeps authored winning overrides read-only and private", async () => {
  const owned = { own: { name: "App owned", settings: { baseURL: "https://synthetic-owned.invalid/v1", apiKey: "synthetic-owned-key" } },
    shadow: { name: "App shadowed", settings: { baseURL: "https://synthetic-shadow.invalid/v1", apiKey: "synthetic-shadow-key" } } };
  const authored = { shadow: { name: "Authored winning name" }, authored: { name: "Authored only", settings: { baseURL: "https://synthetic-authored.invalid/v1", apiKey: "synthetic-authored-key" } } };
  let setup: { config: ServerConfig; projection: string } | undefined;
  const engine = await nativeMcpEngine(async root => {
    const directory = join(root, "project");
    const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "synthetic-client", hostToken: "synthetic-host", configPath: join(root, "server.json"),
      workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [directory],
      readOnly: false, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    await writeRuntimeOpencodeConfig(config, "matter", () => ({ providers: owned }));
    setup = { config, projection: await writeNativeProjectProjection(config, config.workspaces[0]!, { providers: owned }) };
    return { providers: authored, policies: [{ action: "provider.use", resource: "*", effect: "deny" }] };
  });
  try {
    if (!setup) throw new Error("Provider fixture setup did not finish");
    const { config, projection } = setup, connection = engine.connection();
    config.opencodeBaseUrl = connection.url; config.opencodeUsername = connection.username; config.opencodePassword = connection.password;
    const entries = await engine.client().config.get({ location: engine.location });
    expect(entries.some(entry => entry.type === "document" && entry.path === projection && entry.info.providers?.own?.name === "App owned")).toBe(true);
    // OPENCODE_CONFIG_CONTENT is a higher priority native document. Its
    // partial override retains the lower document's private endpoint.
    const display = await nativeProviderDisplay(config, config.workspaces[0]!, { authored, owned, combined: { ...owned, ...authored } });
    expect(display).toEqual({ own: { hasCustomEndpoint: true, editable: true }, shadow: { hasCustomEndpoint: true, editable: false }, authored: { hasCustomEndpoint: true, editable: false } });
    for (const marker of ["synthetic-owned", "synthetic-shadow", "synthetic-authored"]) expect(JSON.stringify(display)).not.toContain(marker);
    const raw = JSON.stringify(entries);
    expect(raw).toContain("synthetic-owned-key"); expect(raw).toContain("synthetic-authored-key");
    expect(await engine.client().session.active()).toEqual({});
  } finally { await engine.close(); }
}, 30_000);
