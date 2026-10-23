import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

test("batched group metadata and reload events do not bootstrap disconnected projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-request-metadata-"));
  const folder = join(root, "disconnected-project");
  const existing = join(root, "existing-project");
  await mkdir(existing);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "metadata", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["http://app.test"],
    workspaces: Array.from({ length: 18 }, (_, i) => ({ id: `ws_${i}`, name: `Project ${i}`, path: i === 0 ? existing : join(folder, String(i)), preset: "starter", workspaceType: "local" })),
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  const base = `http://127.0.0.1:${server.port}`;
  const call = (path: string, init?: RequestInit) => fetch(base + path, { ...init, headers: { Authorization: "Bearer metadata", "content-type": "application/json", ...init?.headers } });
  try {
    const first = `/session-groups/events?${new URLSearchParams({ cursors: JSON.stringify(Object.fromEntries(config.workspaces.map(workspace => [workspace.id, null]))) })}`;
    expect((await fetch(base + first)).status).toBe(401);
    const preflight = await fetch(base + first, { method: "OPTIONS", headers: { Origin: "http://app.test" } });
    expect(preflight.headers.get("access-control-max-age")).toBe("600");
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://app.test");
    const deniedOrigin = await fetch(base + first, { method: "OPTIONS", headers: { Origin: "http://other.test" } });
    expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();
    const response = await call(first); expect(response.status).toBe(200);
    const initial = await response.json(); expect(initial.items).toHaveLength(18);
    expect(initial.items.every((item: { state: { groups: unknown[] } }) => item.state.groups.length === 0)).toBe(true);
    expect((await call("/workspace/ws_0/events")).status).toBe(200);
    expect((await call("/session-inbox")).status).toBe(200);
    await expect(stat(folder)).rejects.toThrow();
    await expect(stat(join(existing, ".opencode"))).rejects.toThrow();
    const unchanged = await (await call(first.replaceAll("null", "0"))).json();
    expect(unchanged.items.every((item: { state?: unknown }) => item.state === undefined)).toBe(true);
    expect((await call("/workspace/ws_0/session-groups", { method: "POST", body: JSON.stringify({ label: "Changed remotely" }) })).status).toBe(200);
    const changed = await (await call(first.replaceAll("null", "0"))).json();
    expect(changed.items.filter((item: { state?: unknown }) => item.state)).toHaveLength(1);
    expect(changed.items[0].state.groups[0].label).toBe("Changed remotely");
    const reset = await (await call(`/session-groups/events?${new URLSearchParams({ cursors: JSON.stringify({ ws_1: 999 }) })}`)).json();
    expect(reset.items[0].state.groups).toEqual([]);
    for (const cursors of ["broken", "[]", '{"ws_0":-1}', '{"ws_0":"bad"}']) {
      expect((await call(`/session-groups/events?${new URLSearchParams({ cursors })}`)).status).toBe(400);
    }
    const unknown = await (await call(`/session-groups/events?${new URLSearchParams({ cursors: JSON.stringify({ unknown: null }) })}`)).json();
    expect(unknown.items).toEqual([]);
    config.authorizedRoots = [];
    expect((await call("/workspace/ws_0/events")).status).toBe(403);
    const denied = await (await call(first)).json(); expect(denied.items).toEqual([]);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
}, 10000);
