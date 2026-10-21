import { closeTestRuntime, removeTestDirectory } from "./runtime.test-helpers.js";
import { spawnSync } from "node:child_process";
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedServer } from "./embedded.js";
import { serve } from "./serve-node.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { grantWikiAgentSession } from "./wiki/agent-access.js";
import * as managedOpencode from "./managed-opencode.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

function configFor(root: string): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"),
    token: "test-client", hostToken: "test-host", workspaces: [], authorizedRoots: [],
    readOnly: true, approval: { mode: "manual", timeoutMs: 1000 }, corsOrigins: [],
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  } satisfies ServerConfig;
}

// The child calls back using only the credentials and address it actually
// inherited, rather than test code supplying the server's correct address.
const engine = `#!${process.execPath}
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/probe") return Response.json({ healthy: true });
  const results = [];
  for (const path of ["/wikis", "/workspace/" + url.searchParams.get("workspace") + "/storage/roots"]) {
    const response = await fetch(process.env.LEGALWORK_SERVER_URL + path, { headers: {
      authorization: "Bearer " + process.env.LEGALWORK_SERVER_TOKEN,
      "x-legalwork-wiki-agent-token": process.env.LEGALWORK_WIKI_AGENT_TOKEN,
      "x-legalwork-wiki-agent-session": "verified-session",
      "x-legalwork-wiki-agent-directory": encodeURIComponent(url.searchParams.get("directory")),
    } });
    results.push({ path, status: response.status, data: await response.json() });
  }
  return Response.json({ url: process.env.LEGALWORK_SERVER_URL, results });
} });
console.log("opencode server listening on http://127.0.0.1:" + server.port);
`;

test("managed agent authenticates wiki and storage tools after the preferred server port is occupied", async () => {
  const root = await mkdtemp(join(tmpdir(), "embedded-agent-port-"));
  cleanup.push(() => removeTestDirectory(root));
  const previous = { ...process.env };
  cleanup.push(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "LEGALWORK_RUNTIME_DB", "LEGALWORK_TOKEN_STORE", "LEGALWORK_STORAGE_STORE"])
    process.env[key] = join(root, key);
  delete process.env.LEGALWORK_OPENCODE_BASE_URL;
  delete process.env.OPENCODE_DB;
  cleanup.push(() => closeTestRuntime(configFor(root)));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const script = join(root, "engine.ts");
  const bin = process.platform === "win32" ? join(root, "engine.exe") : script;
  await writeFile(script, engine);
  if (process.platform === "win32") {
    const compiled = spawnSync(process.execPath, ["build", script, "--compile", "--outfile", bin], { encoding: "utf8" });
    if (compiled.status !== 0) throw new Error(`Could not build engine fixture: ${compiled.stderr}`);
  } else await chmod(bin, 0o755);
  const oldServer = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ code: "wrong_server" }, { status: 403 }) });
  cleanup.push(async () => oldServer.stop());
  const server = await startEmbeddedServer({
    host: "127.0.0.1", port: oldServer.port, workspaces: [workspace],
    configPath: join(root, "server.json"), readOnly: true, logRequests: false,
    token: "test-client", hostToken: "test-host", manageOpencode: true, opencodeBin: bin,
  });
  cleanup.push(() => server.stop());
  expect(server.port).not.toBe(oldServer.port);
  expect(server.config.port).toBe(server.port);
  const entry = server.config.workspaces[0];
  await grantWikiAgentSession(server.config, { sessionId: "verified-session", directory: workspace, scope: "owner" });
  const query = new URLSearchParams({ workspace: entry.id, directory: workspace });
  const probe = await fetch(`${server.config.opencodeBaseUrl}/probe?${query}`);
  const result = await probe.json();
  expect(result.url).toBe(server.url);
  expect(result.results.map((item: { status: number }) => item.status)).toEqual([200, 200]);
  expect(server.managedOpencodeExecution?.env.find(item => item.name === "LEGALWORK_WIKI_AGENT_TOKEN")?.redacted).toBe(true);
}, 30_000);

test("startup stays unavailable until initialization succeeds and releases its listener on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "server-init-failure-"));
  cleanup.push(() => removeTestDirectory(root));
  const config = configFor(root);
  cleanup.push(() => closeTestRuntime(config));
  let boundPort = 0;
  await expect(startServer(config, { onListening: async port => {
    boundPort = port;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(503);
    throw new Error("engine startup failed");
  } })).rejects.toThrow("engine startup failed");
  expect(boundPort).toBeGreaterThan(0);
  await expect(fetch(`http://127.0.0.1:${boundPort}/health`)).rejects.toThrow();
});

test("an explicit missing desktop SDK prevents engine spawn and package downloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "embedded-missing-sdk-"));
  cleanup.push(() => removeTestDirectory(root));
  const previous = { ...process.env };
  cleanup.push(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "LEGALWORK_RUNTIME_DB", "LEGALWORK_TOKEN_STORE", "LEGALWORK_STORAGE_STORE"])
    process.env[key] = join(root, key);
  delete process.env.LEGALWORK_OPENCODE_BASE_URL;
  delete process.env.OPENCODE_DB;
  cleanup.push(() => closeTestRuntime(configFor(root)));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const spawn = spyOn(managedOpencode, "createManagedOpencodeServer").mockRejectedValue(new Error("Engine must not be spawned"));
  try {
    await expect(startEmbeddedServer({
      host: "127.0.0.1", port: 0, workspaces: [workspace], configPath: join(root, "server.json"),
      readOnly: true, logRequests: false, token: "test-client", hostToken: "test-host", manageOpencode: true,
      opencodeSdkDirectory: join(root, "missing-desktop-resources"),
    })).rejects.toThrow("Bundled OpenCode plugin SDK is missing");
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});
