import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMcp, getMcpConfig, listMcp, listMcpDisplay, mcpDisplayItem, mergeMcpEdit, removeMcp } from "./mcp.js";
import { readGlobalMcpMap } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

test("native server maps retain full definitions and distinguish a legacy connector named servers", () => {
  const definition = { type: "remote", url: "{env:PRIVATE_MCP_URL}", headers: { Authorization: "{file:secret}" },
    timeout: { startup: 70000, execution: 150000 }, disabled: true, oauth: { client_id: "client", client_secret: "secret" } };
  expect(getMcpConfig({ mcp: { timeout: { startup: 1000 }, servers: { legalmemory: definition } } })).toEqual({ legalmemory: definition });
  expect(getMcpConfig({ mcp: { servers: { type: "local", command: ["custom-server"] } } })).toEqual({ servers: { type: "local", command: ["custom-server"] } });
  expect(getMcpConfig({ mcp: [] })).toEqual({});
});

test("connector display contains presence and setup metadata without credential-bearing executable values", () => {
  const fixtureURL = new URL("https://example.com/private-token?key=query-token");
  fixtureURL.username = "username"; fixtureURL.password = "secret";
  const config = { type: "remote", url: fixtureURL.href, cwd: "/private-token",
    command: ["program", "--token=command-token"], headers: { Authorization: "Bearer header-token" }, environment: { SECRET: "environment-token" },
    oauth: { client_id: "client-token", client_secret: "oauth-token" }, timeout: { execution: 75000 }, disabled: true };
  const display = mcpDisplayItem({ name: "legalmemory", source: "config.project", config });
  expect(display.editable).toBe(false);
  expect(display.config).toEqual({ type: "remote", enabled: false, timeout: 75000, oauth: {} });
  expect(display.configured).toEqual({ url: true, command: true, cwd: true, headers: ["Authorization"], environment: ["SECRET"], oauth: true, variables: [] });
  for (const secret of ["private-token", "query-token", "command-token", "header-token", "environment-token", "client-token", "oauth-token"]) {
    expect(JSON.stringify(display)).not.toContain(secret);
  }
  expect(mcpDisplayItem({ name: "token", source: "config.remote", config: { type: "remote", url: "${SERVER_URL}", enabled: false, headers: { Authorization: "${TOKEN}" } } }).configured.variables).toEqual(["SERVER_URL", "TOKEN"]);
});

test("connector edits preserve omitted credentials and remove only explicit names", () => {
  const current = { type: "remote", url: "https://private-token.example/mcp", headers: { Authorization: "saved-token", "x-routing": "route" },
    environment: { KEY: "saved-key", REMOVE: "old" }, oauth: { clientId: "id", clientSecret: "saved-oauth" }, cwd: "/saved", timeout: 60000 };
  const edited = mergeMcpEdit(current, { type: "remote", enabled: false, headers: { authorization: "replacement" }, oauth: { scope: "read" } },
    { removeHeaders: ["X-ROUTING"], removeEnvironment: ["REMOVE"], resetFields: ["cwd", "timeout"] });
  expect(edited).toEqual({ type: "remote", enabled: false, url: current.url, headers: { authorization: "replacement" }, environment: { KEY: "saved-key" },
    oauth: { clientId: "id", clientSecret: "saved-oauth", scope: "read" } });
  expect(current.headers.Authorization).toBe("saved-token");
});

test("stored connector metadata edits preserve saved values and leave native authored files intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-mcp-native-display-"));
  const project = join(root, "project"); await mkdir(project);
  const previousDb = process.env.LEGALWORK_RUNTIME_DB, previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.db"); process.env.XDG_CONFIG_HOME = join(root, "xdg");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const authored = '// Native definitions remain authored\n{"mcp":{"servers":{"authored":{"type":"remote","url":"{env:PRIVATE_ENDPOINT}","disabled":true}}}}\n';
  const path = join(project, "opencode.jsonc"); await writeFile(path, authored);
  try {
    const saved = { type: "remote", url: "https://saved-token.example/mcp", headers: { Authorization: "Bearer saved-token" }, oauth: false };
    await addMcp(config, "matter", "managed", saved);
    await addMcp(config, "matter", "managed", { type: "remote", enabled: false }, "global", {});
    expect((await readGlobalMcpMap(config)).managed).toEqual({ ...saved, enabled: false });
    const display = await listMcpDisplay(config, config.workspaces[0]!);
    expect(display.map(item => item.name)).toEqual(["authored", "managed"]);
    expect(JSON.stringify(display)).not.toContain("saved-token");
    expect(display.find(item => item.name === "managed")?.editable).toBe(true);
    expect(display.find(item => item.name === "authored")?.editable).toBe(false);
    await addMcp(config, "matter", "setup", { type: "remote", enabled: false, url: "${SERVER_URL}",
      headers: { Authorization: "Basic ${BASIC_AUTH_CREDENTIALS}" }, environment: { RAW: "${BASIC_AUTH_CREDENTIALS}" } });
    await addMcp(config, "matter", "setup", { type: "remote", enabled: true }, "global",
      { variables: { SERVER_URL: "https://configured.example/mcp", BASIC_AUTH_CREDENTIALS: "lawyer:pässword" } });
    expect((await readGlobalMcpMap(config)).setup).toEqual({ type: "remote", enabled: true, url: "https://configured.example/mcp",
      headers: { Authorization: "Basic " + Buffer.from("lawyer:pässword", "utf8").toString("base64") }, environment: { RAW: "lawyer:pässword" } });
    await addMcp(config, "matter", "local", { type: "local", command: ["saved-executable", "--saved-argument"] });
    await Promise.all([
      addMcp(config, "matter", "local", { type: "local" }, "global", { executable: "replacement-executable" }),
      addMcp(config, "matter", "local", { type: "local", environment: { NEW_SETTING: "kept" } }, "global", {}),
    ]);
    expect((await readGlobalMcpMap(config)).local).toEqual({ type: "local", command: ["replacement-executable", "--saved-argument"], environment: { NEW_SETTING: "kept" } });
    await addMcp(config, "matter", "local", { type: "local" }, "global", { arguments: [] });
    expect((await readGlobalMcpMap(config)).local?.command).toEqual(["replacement-executable"]);
    expect(await removeMcp(config, "matter", "authored")).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(authored);
    expect((await listMcp(config, "matter", project)).find(item => item.name === "authored")?.config.url).toBe("{env:PRIVATE_ENDPOINT}");
  } finally {
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
    await rm(root, { recursive: true, force: true });
  }
});
