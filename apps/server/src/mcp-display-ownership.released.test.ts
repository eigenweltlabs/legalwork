import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeNativeProjectProjection } from "./engine-project.js";
import { listMcpDisplay } from "./mcp.js";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { closeRuntimeOpencodeConfig, GLOBAL_MCP_ID, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

test.skipIf(!nativeMcpBinary)("an authored connector override stays read-only even when its name also exists in the shared library", async () => {
  let config: ServerConfig | undefined;
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  const engine = await nativeMcpEngine(async root => {
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    const project = join(root, "project");
    config = { host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "synthetic", hostToken: "synthetic-host",
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [project], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const servers = { collision: { type: "remote", url: "https://saved-private-token.example/mcp", disabled: true }, selected: { type: "remote", url: "https://selected.example/mcp", disabled: true } };
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, () => Schema.decodeUnknownSync(Config.Info)({ mcp: { servers } }));
    await writeNativeProjectProjection(config, config.workspaces[0]!, { mcp: { servers: {
      collision: { type: "remote", url: "https://saved-private-token.example/mcp", disabled: true },
      selected: { type: "remote", url: "https://selected.example/mcp", disabled: true },
    } } });
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeFile(join(project, ".opencode", "opencode.jsonc"), JSON.stringify({ mcp: { servers: { collision: { type: "remote", url: "https://authored-private-token.example/mcp", disabled: true } } } }));
    return {};
  });
  try {
    if (!config) throw new Error("Missing private fixture configuration");
    const connection = engine.connection();
    config.opencodeBaseUrl = connection.url; config.opencodeUsername = connection.username; config.opencodePassword = connection.password;
    const entries = await engine.client().config.get({ location: engine.location });
    expect(JSON.stringify(entries)).toContain("authored-private-token");
    const display = await listMcpDisplay(config, config.workspaces[0]!);
    expect(display.find(item => item.name === "collision")).toMatchObject({ source: "config.project", editable: false });
    expect(display.find(item => item.name === "selected")).toMatchObject({ source: "config.remote", editable: true });
    expect(JSON.stringify(display)).not.toContain("private-token");
  } finally {
    if (config) await closeRuntimeOpencodeConfig(config);
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await engine.close();
  }
});
