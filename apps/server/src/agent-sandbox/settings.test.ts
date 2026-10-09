import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import { closeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import { networkModeSchema, readSandboxNetworkMode } from "./settings.js";

test("network settings API authenticates, validates, persists and respects read-only mode", async () => {
  const childRoot = process.env.LEGALWORK_NETWORK_API_TEST_ROOT;
  if (!childRoot) {
    const root = await mkdtemp(join(tmpdir(), "sandbox-network-api-"));
    // The full server owns process-lifetime database caches. Exit the fixture
    // process before deleting its profile so Windows releases every handle.
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.filename], {
        env: { ...process.env, LEGALWORK_NETWORK_API_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return;
  }
  const root = childRoot;
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, agentSandboxEnabled: true, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}`;
  const hostHeaders = { "x-legalwork-host-token": "host", "content-type": "application/json" };
  const patch = (body: unknown, token?: string) => fetch(base + "/sandbox/network", { method: "PATCH", headers: {
    "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
  try {
    expect((await patch({ mode: "allow" })).status).toBe(401);
    const issued = await fetch(base + "/tokens", { method: "POST", headers: hostHeaders, body: JSON.stringify({ scope: "viewer", label: "network-policy-test" }) });
    expect(issued.status).toBe(201);
    const viewer = await issued.json();
    expect((await patch({ mode: "allow" }, viewer.token)).status).toBe(403);
    for (const body of [{ mode: "unknown" }, { mode: "allow", extra: true }, { mode: null }, {}]) {
      expect((await patch(body, "client")).status).toBe(400);
      expect(await readSandboxNetworkMode(config)).toBe("approve");
    }
    for (const mode of networkModeSchema.options) {
      const response = await patch({ mode }, "client");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ networkMode: mode });
      expect(await readSandboxNetworkMode(config)).toBe(mode);
    }
    config.readOnly = true;
    expect((await patch({ mode: "allow" }, "client")).status).toBe(403);
    expect(await readSandboxNetworkMode(config)).toBe("approve");
  } finally {
    await server.stop();
    await closeRuntimeOpencodeConfig(config);
  }
}, 30000);
