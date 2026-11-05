import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startServer } from "./server.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { readManagedEngineSettings } from "./managed-engine-settings.js";
import { nativeOpencodeConfig } from "./native-opencode-config.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

type EngineRequest = {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
  definitions?: Record<string, unknown>;
};

// Keep the engine sync retry backoff tiny so failure-path tests stay fast.
process.env.LEGALWORK_MCP_SYNC_RETRY_DELAY_MS = "10";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-mcp-engine-sync-"));
  roots.push(root);
  return root;
}

function startMockOpencode(options?: { failMcpNames?: string[]; disconnectStatus?: number; failDisconnectDirectories?: string[] }) {
  const requests: EngineRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

      if (url.pathname === "/api/info") return Response.json({ version: "2.1.4", pid: process.pid });
      if (url.pathname === "/api/config") return Response.json([]);
      if (url.pathname === "/api/rpc/legalwork.managed-settings/refresh") {
        const path = process.env.LEGALWORK_RUNTIME_DB;
        if (!path) throw new Error("The fixture requires a private runtime store");
        const settings = await readManagedEngineSettings(join(dirname(path), "runtime-opencode-settings.json"), url.searchParams.get("location[directory]") ?? "");
        const native = nativeOpencodeConfig(settings.configuration && typeof settings.configuration === "object" && !Array.isArray(settings.configuration) ? Object.fromEntries(Object.entries(settings.configuration)) : {}).config;
        const latest = requests.at(-1);
        if (latest) latest.definitions = native.mcp?.servers ?? {};
        if (Object.keys(native.mcp?.servers ?? {}).some(name => options?.failMcpNames?.includes(name))) return Response.json({ code: "refresh_failed" }, { status: 500 });
        return Response.json({ refreshed: true });
      }
      if (/^\/api\/experimental\/mcp\/[^/]+\/disconnect$/.test(url.pathname) && request.method === "POST") {
        if (options?.failDisconnectDirectories?.includes(url.searchParams.get("location[directory]") ?? "")) return Response.json({}, { status: 500 });
        const status = options?.disconnectStatus ?? 204;
        return status === 204 ? new Response(null, { status }) : Response.json({}, { status });
      }
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startLegalworkServer(workspaceRoot: string, opencodeBaseUrl: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: opencodeBaseUrl,
      },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const POSTHOG_CONFIG = {
  type: "remote",
  url: "https://mcp.posthog.com/mcp",
  enabled: true,
  oauth: {},
};

async function startLegalworkServerWithWorkspaces(roots: string[], opencodeBaseUrl: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: roots.map((path, index) => ({
      id: `ws_${index + 1}`,
      name: `Workspace ${index + 1}`,
      path,
      preset: "starter",
      workspaceType: "local",
      baseUrl: opencodeBaseUrl,
    })),
    authorizedRoots: roots,
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

describe("runtime MCP engine sync", () => {
  test("a shared connector is hot-added into every local workspace's engine instance, and dropped from all on removal", async () => {
    const rootA = await createWorkspaceRoot();
    const rootB = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(rootA, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const legalwork = await startLegalworkServerWithWorkspaces([rootA, rootB], `http://127.0.0.1:${mock.server.port}`);

      const response = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(legalwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG, scope: "global" }),
      });
      expect(response.status).toBe(200);
      const adds = mock.requests.filter((entry) => entry.method === "POST" && entry.pathname === "/api/rpc/legalwork.managed-settings/refresh");
      expect(adds.map((entry) => new URLSearchParams(entry.search).get("location[directory]")).sort()).toEqual([rootA, rootB].sort());
      expect(adds.every(entry => entry.definitions?.posthog !== undefined)).toBe(true);

      mock.requests.length = 0;
      const removal = await fetch(`${legalwork.base}/workspace/ws_2/mcp/posthog`, {
        method: "DELETE",
        headers: auth(legalwork.token),
      });
      expect(removal.status).toBe(200);
      const disconnects = mock.requests.filter((entry) => entry.pathname === "/api/experimental/mcp/posthog/disconnect");
      expect(disconnects.map((entry) => new URLSearchParams(entry.search).get("location[directory]")).sort()).toEqual([rootA, rootB].sort());
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("retries a failed shared disconnect without removing another workspace's own connector", async () => {
    const rootA = await createWorkspaceRoot();
    const rootB = await createWorkspaceRoot();
    const rootC = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.LEGALWORK_RUNTIME_DB = join(rootA, "runtime.sqlite");
    process.env.XDG_CONFIG_HOME = join(rootA, "config");
    try {
      const options = { failDisconnectDirectories: [rootB] };
      const mock = startMockOpencode(options);
      const legalwork = await startLegalworkServerWithWorkspaces([rootA, rootB, rootC], `http://127.0.0.1:${mock.server.port}`);
      for (const [workspace, scope] of [["ws_1", "global"], ["ws_3", "workspace"]]) {
        const response = await fetch(`${legalwork.base}/workspace/${workspace}/mcp`, {
          method: "POST", headers: auth(legalwork.token),
          body: JSON.stringify({ name: "legalmemory", config: POSTHOG_CONFIG, scope }),
        });
        expect(response.status).toBe(200);
      }
      mock.requests.length = 0;
      const remove = () => fetch(`${legalwork.base}/workspace/ws_1/mcp/legalmemory`, {
        method: "DELETE", headers: auth(legalwork.token),
      });
      expect((await remove()).status).toBe(502);
      options.failDisconnectDirectories = [];
      expect((await remove()).status).toBe(200);
      const directories = mock.requests
        .filter((entry) => entry.pathname === "/api/experimental/mcp/legalmemory/disconnect")
        .map((entry) => new URLSearchParams(entry.search).get("location[directory]"));
      expect(directories).toEqual([rootA, rootB, rootA, rootB]);
      const response = await fetch(`${legalwork.base}/workspace/ws_3/mcp`, { headers: auth(legalwork.token) });
      const displayed = await response.json();
      expect(displayed.items).toHaveLength(1);
      expect(displayed.items[0]).toMatchObject({ name: "legalmemory", config: { type: "remote", enabled: true, oauth: {} }, configured: { url: true } });
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });

  test("hot-adds a runtime MCP into the running engine when added", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const legalwork = await startLegalworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const response = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(legalwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);

      const addRequest = mock.requests.find((entry) => entry.method === "POST" && entry.pathname === "/api/rpc/legalwork.managed-settings/refresh");
      expect(addRequest).toBeDefined();
      expect(addRequest?.definitions?.posthog).toMatchObject({ type: "remote", url: POSTHOG_CONFIG.url, disabled: false, oauth: {} });
      expect(addRequest?.search).toContain(`location%5Bdirectory%5D=${encodeURIComponent(workspaceRoot)}`);
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("re-registers runtime MCPs with the engine after a reload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const legalwork = await startLegalworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const addResponse = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(legalwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(addResponse.status).toBe(200);
      mock.requests.length = 0;

      const reloadResponse = await fetch(`${legalwork.base}/workspace/ws_1/engine/reload`, {
        method: "POST",
        headers: auth(legalwork.token),
      });
      expect(reloadResponse.status).toBe(200);

      const disposeIndex = mock.requests.findIndex((entry) => entry.pathname === "/api/rpc/legalwork.managed-settings/refresh");
      const syncIndex = mock.requests.findIndex((entry) => entry.method === "POST" && entry.pathname === "/api/rpc/legalwork.managed-settings/refresh");
      expect(disposeIndex).toBeGreaterThanOrEqual(0);
      expect(syncIndex).toBeGreaterThanOrEqual(disposeIndex);
      expect(mock.requests[syncIndex]?.definitions?.posthog).toMatchObject({ type: "remote", url: POSTHOG_CONFIG.url });
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("pushes toggled enabled state to the engine", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const legalwork = await startLegalworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const addResponse = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(legalwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(addResponse.status).toBe(200);
      mock.requests.length = 0;

      const toggleResponse = await fetch(`${legalwork.base}/workspace/ws_1/mcp/posthog/enabled`, {
        method: "POST",
        headers: auth(legalwork.token),
        body: JSON.stringify({ enabled: false }),
      });
      expect(toggleResponse.status).toBe(200);

      const syncRequest = mock.requests.find((entry) => entry.method === "POST" && entry.pathname === "/api/rpc/legalwork.managed-settings/refresh");
      expect(syncRequest).toBeDefined();
      expect(syncRequest?.definitions?.posthog).toMatchObject({ type: "remote", disabled: true });
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("disconnects a removed MCP from the engine", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode();
      const legalwork = await startLegalworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      const addResponse = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(legalwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(addResponse.status).toBe(200);
      mock.requests.length = 0;

      const removeResponse = await fetch(`${legalwork.base}/workspace/ws_1/mcp/posthog`, {
        method: "DELETE",
        headers: auth(legalwork.token),
      });
      expect(removeResponse.status).toBe(200);

      const disconnectRequest = mock.requests.find(
        (entry) => entry.method === "POST" && entry.pathname === "/api/experimental/mcp/posthog/disconnect",
      );
      expect(disconnectRequest).toBeDefined();
      expect(disconnectRequest?.search).toContain(`location%5Bdirectory%5D=${encodeURIComponent(workspaceRoot)}`);
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("reports failed disconnects and retries even after the saved entry is gone", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const options = { disconnectStatus: 500 };
      const mock = startMockOpencode(options);
      const legalwork = await startLegalworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);
      await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST", headers: auth(legalwork.token),
        body: JSON.stringify({ name: "legalmemory", config: POSTHOG_CONFIG }),
      });
      const remove = () => fetch(`${legalwork.base}/workspace/ws_1/mcp/legalmemory`, {
        method: "DELETE", headers: auth(legalwork.token),
      });
      expect((await remove()).status).toBe(502);
      options.disconnectStatus = 204;
      expect((await remove()).status).toBe(200);
      expect(mock.requests.filter((entry) => entry.pathname === "/api/experimental/mcp/legalmemory/disconnect")).toHaveLength(2);
      options.disconnectStatus = 404;
      expect((await remove()).status).toBe(200);
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("does not report a successful disable when the engine rejects it", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const options: { failMcpNames: string[] } = { failMcpNames: [] };
      const mock = startMockOpencode(options);
      const legalwork = await startLegalworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);
      await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST", headers: auth(legalwork.token),
        body: JSON.stringify({ name: "legalmemory", config: POSTHOG_CONFIG }),
      });
      options.failMcpNames.push("legalmemory");
      const response = await fetch(`${legalwork.base}/workspace/ws_1/mcp/legalmemory/enabled`, {
        method: "POST", headers: auth(legalwork.token), body: JSON.stringify({ enabled: false }),
      });
      expect(response.status).toBe(502);
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("a failed native location refresh preserves all saved connector definitions and reports the failure", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const mock = startMockOpencode({ failMcpNames: ["bad"] });
      const legalwork = await startLegalworkServer(workspaceRoot, `http://127.0.0.1:${mock.server.port}`);

      for (const [name, config] of [["bad", POSTHOG_CONFIG], ["posthog", POSTHOG_CONFIG]] as const) {
        const response = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
          method: "POST",
          headers: auth(legalwork.token),
          body: JSON.stringify({ name, config }),
        });
        expect(response.status).toBe(200);
      }
      mock.requests.length = 0;

      const reloadResponse = await fetch(`${legalwork.base}/workspace/ws_1/engine/reload`, {
        method: "POST",
        headers: auth(legalwork.token),
      });
      expect(reloadResponse.status).toBe(502);

      const syncedNames = mock.requests
        .filter((entry) => entry.method === "POST" && entry.pathname === "/api/rpc/legalwork.managed-settings/refresh")
        .flatMap(entry => Object.keys(entry.definitions ?? {}));
      // "bad" fails with a 500 but must not block the entries after it.
      expect(syncedNames).toContain("bad");
      expect(syncedNames).toContain("posthog");
      // Native configuration refresh is atomic for the location. A failed
      // refresh retains every saved definition for the next successful load.
      expect(syncedNames.filter((name) => name === "bad").length).toBe(1);

      // The failure is surfaced on the MCP list endpoint instead of being
      // swallowed silently.
      const listResponse = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        headers: auth(legalwork.token),
      });
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as {
        engineSync?: { status: string; failures: Array<{ name: string }> } | null;
      };
      expect(listBody.engineSync?.status).toBe("failed");
      expect(listBody.engineSync?.failures.map((failure) => failure.name)).toContain("bad");
      expect(listBody.engineSync?.failures.map((failure) => failure.name)).toContain("posthog");
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });

  test("MCP add still succeeds when the engine is unreachable", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const previousDb = process.env.LEGALWORK_RUNTIME_DB;
    process.env.LEGALWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    try {
      const legalwork = await startLegalworkServer(workspaceRoot, "http://127.0.0.1:9");

      const response = await fetch(`${legalwork.base}/workspace/ws_1/mcp`, {
        method: "POST",
        headers: auth(legalwork.token),
        body: JSON.stringify({ name: "posthog", config: POSTHOG_CONFIG }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ name: string }> };
      expect(body.items.some((item) => item.name === "posthog")).toBe(true);
    } finally {
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    }
  });
});
