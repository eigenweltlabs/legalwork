import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { storageInputSchema } from "./schema.js";
import { TeamStorage } from "./team.js";
import { StorageStore } from "./store.js";
import { StorageInstallations } from "./installations.js";

const priorEnv = { ...process.env };
let temporary: string;
let config: ServerConfig;
let app: Awaited<ReturnType<typeof startServer>>;
let platform: ReturnType<typeof Bun.serve>;
let calls = 0;
let status = 200;
let payload: unknown;
let release: (() => void) | undefined;
let hold = false;
let tokenSequence = 0;
const id = "af506b2e-82eb-40cd-936a-fef613abc765";
const input = () =>
  storageInputSchema.parse({
    name: "Shared documents",
    config: { kind: "webdav", endpoint: "http://127.0.0.1:1" },
    secrets: { password: "team-secret-not-on-disk" },
  });
const snapshot = (version = 1, orgId = "firm-one") => ({
  schemaVersion: 1,
  orgId,
  canManage: true,
  connections: [{ id, version, updatedAt: new Date().toISOString(), input: input() }],
});
async function signIn(workspaceId = "storage-team", orgId = "firm-one", token = "desktop-token") {
  await writeEigenweltConnection(config, workspaceId, {
    platformToken: token,
    account: { userId: "user-one", userName: null, userEmail: null, orgId, orgName: orgId },
  });
}
async function api(method: string, suffix = "", body?: unknown) {
  return fetch(`http://127.0.0.1:${app.port}/workspace/storage-team/storage${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "x-legalwork-host-token": config.hostToken,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "legalwork-team-storage-"));
  for (const key of [
    "LEGALWORK_STORAGE_STORE",
    "LEGALWORK_TOKEN_STORE",
    "LEGALWORK_RUNTIME_DB",
    "LEGALWORK_ENV_STORE",
    "LEGALWORK_DATA_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ])
    process.env[key] = join(temporary, key);
  config = {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "owner-token",
    configPath: join(temporary, "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "storage-team", name: "Team", path: temporary, preset: "default", workspaceType: "local" }],
    authorizedRoots: [temporary],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      calls++;
      expect(req.headers.get("authorization")).toStartWith("Bearer ");
      const captured = payload;
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (req.method === "GET") return Response.json(captured, { status });
      if (status !== 200) return Response.json({ code: "forbidden" }, { status });
      return Response.json({ ok: true });
    },
  });
  process.env.EIGENWELT_PLATFORM_URL = `http://127.0.0.1:${platform.port}`;
  app = await startServer(config);
});
beforeEach(async () => {
  setSystemTime();
  calls = 0;
  status = 200;
  hold = false;
  release = undefined;
  payload = snapshot();
  await signIn("storage-team", "firm-one", `desktop-token-${++tokenSequence}`);
});
afterAll(async () => {
  setSystemTime();
  release?.();
  await app?.stop();
  platform?.stop(true);
  await rm(temporary, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
  Object.assign(process.env, priorEnv);
});

describe("team storage sync", () => {
  test("optional connections require local installation and removal revokes file and search access", async () => {
    payload = {
      ...snapshot(),
      canManage: false,
      connections: [{ ...snapshot().connections[0], input: { ...input(), teamInstallation: "optional" } }],
    };
    expect(
      (await (await api("GET", "/roots")).json()).roots.some((root: { id: string }) => root.id === `team:${id}`),
    ).toBe(false);
    const catalog = await (await api("GET")).json();
    expect(catalog.connections.find((item: { id: string }) => item.id === `team:${id}`).team.installed).toBe(false);
    expect((await api("GET", `/team:${id}/children`)).status).toBe(409);
    expect((await api("POST", `/team:${id}/installation`, { installed: true })).status).toBe(200);
    expect(
      (await (await api("GET", "/roots")).json()).roots.some((root: { id: string }) => root.id === `team:${id}`),
    ).toBe(true);
    expect((await new TeamStorage(config).list("storage-team")).connections[0].team?.installed).toBe(true);
    const saved = await readFile(new StorageInstallations(config).path, "utf8");
    expect(JSON.parse(saved)).toEqual([{ workspaceId: "storage-team", orgId: "firm-one", id }]);
    expect(saved).not.toContain("team-secret-not-on-disk");
    await signIn("other-workspace");
    expect((await new TeamStorage(config).list("other-workspace")).connections[0].team?.installed).toBe(false);
    await signIn("storage-team", "firm-two", "other-firm-token");
    payload = {
      ...snapshot(1, "firm-two"),
      connections: [{ ...snapshot().connections[0], input: { ...input(), teamInstallation: "optional" } }],
    };
    expect((await new TeamStorage(config).list("storage-team")).connections[0].team?.installed).toBe(false);
    await signIn();
    payload = {
      ...snapshot(),
      connections: [{ ...snapshot().connections[0], input: { ...input(), teamInstallation: "optional" } }],
    };
    expect((await api("POST", `/team:${id}/installation`, { installed: false })).status).toBe(200);
    expect(
      (await (await api("GET", "/roots")).json()).roots.some((root: { id: string }) => root.id === `team:${id}`),
    ).toBe(false);
    expect((await api("POST", `/team:${id}/filename-search`, { query: "matter" })).status).toBe(409);
    expect((await api("GET", `/team:${id}/file?path=notes.txt`)).status).toBe(409);
  });
  test("automatic connections cannot be removed locally and unused optional catalogs fail quietly", async () => {
    expect((await api("POST", `/team:${id}/installation`, { installed: false })).status).toBe(409);
    const team = new TeamStorage(config);
    payload = {
      ...snapshot(),
      connections: [{ ...snapshot().connections[0], input: { ...input(), teamInstallation: "optional" } }],
    };
    expect((await team.list("storage-team")).connections[0].team?.installed).toBe(false);
    status = 503;
    expect((await team.list("storage-team", true)).status.error).toBeUndefined();
  });
  test("keeps optional discovery quiet before any shared connections have been configured", async () => {
    for (const unavailable of [403, 404, 503]) {
      const team = new TeamStorage(config);
      status = unavailable;
      const before = calls;
      expect(await team.list("storage-team")).toEqual({
        connections: [],
        status: { connected: false, canManage: false },
      });
      await team.list("storage-team");
      expect(calls - before).toBe(1);
      // An explicitly requested admin operation must still report its failure.
      await expect(team.request("storage-team", "POST", "", input())).rejects.toMatchObject({ status: unavailable });
    }
  });
  test("clears warnings after all shared connections are removed or the firm changes", async () => {
    const team = new TeamStorage(config);
    await team.list("storage-team");
    status = 503;
    expect((await team.list("storage-team", true)).status.error).toBeDefined();
    expect((await team.list("storage-team", true)).connections).toEqual([]);
    status = 200;
    payload = { ...snapshot(), connections: [] };
    expect((await team.list("storage-team", true)).status.error).toBeUndefined();
    status = 503;
    expect((await team.list("storage-team", true)).status.error).toBeUndefined();
    status = 200;
    payload = snapshot();
    await team.list("storage-team", true);
    await signIn("storage-team", "firm-two", "second-token");
    status = 503;
    expect((await team.list("storage-team", true)).status.error).toBeUndefined();
  });
  test("loads lazily, caches a bounded lease, and replaces updates and deletions", async () => {
    const team = new TeamStorage(config);
    expect(calls).toBe(0);
    const first = await team.list("storage-team");
    expect(first.connections[0].id).toBe(`team:${id}`);
    expect(first.connections[0].secrets.password).toBe("team-secret-not-on-disk");
    await Promise.all([team.list("storage-team"), team.list("storage-team")]);
    expect(calls).toBe(1);
    payload = snapshot(2);
    setSystemTime(Date.now() + 30_001);
    expect((await team.list("storage-team")).connections[0].team?.version).toBe(2);
    payload = { ...snapshot(), connections: [] };
    expect((await team.list("storage-team", true)).connections).toEqual([]);
  });
  test("discards credentials on rejected sync, malformed responses and mismatched firms", async () => {
    const team = new TeamStorage(config);
    await team.list("storage-team");
    status = 403;
    expect((await team.list("storage-team", true)).connections).toEqual([]);
    expect((await team.list("storage-team")).status.error).toBeDefined();
    status = 200;
    for (const invalid of [
      snapshot(1, "another-firm"),
      { ...snapshot(), schemaVersion: 2 },
      { ...snapshot(), connections: [...snapshot().connections, ...snapshot().connections] },
      { bad: "team-secret-not-on-disk" },
    ]) {
      payload = invalid;
      const result = await team.list("storage-team", true);
      expect(result.connections).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("team-secret-not-on-disk");
    }
  });
  test("clears sign-out, isolates workspaces and rejects an old firm's in-flight response", async () => {
    const team = new TeamStorage(config);
    await team.list("storage-team");
    expect((await team.list("unsigned-workspace")).connections).toEqual([]);
    await writeEigenweltConnection(config, "storage-team", { platformToken: null, account: null });
    expect((await team.list("storage-team")).connections).toEqual([]);
    await signIn();
    hold = true;
    const old = team.list("storage-team", true);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await signIn("storage-team", "firm-two", "new-desktop-token");
    release();
    expect((await old).connections).toEqual([]);
    payload = snapshot(1, "firm-two");
    expect((await team.list("storage-team")).connections[0].team?.orgId).toBe("firm-two");
  });
  test("does not restore a stale sync after an admin mutation", async () => {
    const team = new TeamStorage(config);
    hold = true;
    const old = team.list("storage-team");
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    team.invalidate("storage-team");
    payload = snapshot(2);
    expect((await team.list("storage-team")).connections[0].team?.version).toBe(2);
    release();
    expect((await old).connections).toEqual([]);
    expect((await team.list("storage-team")).connections[0].team?.version).toBe(2);
  });
  test("exposes managed roots and safe settings without persisting team credentials", async () => {
    const store = new StorageStore(config);
    await store.save("storage-team", storageInputSchema.parse({ ...input(), name: "Personal", secrets: {} }));
    const roots = await (await api("GET", "/roots")).json();
    expect(roots.roots).toContainEqual({
      id: `team:${id}`,
      name: "Shared documents",
      kind: "webdav",
      writable: true,
      revision: "firm-one:1",
    });
    const settings = await (await api("GET")).text();
    expect(settings).toContain('"canManage":true');
    expect(settings).toContain('"configuredSecrets":["password"]');
    expect(settings).not.toContain("team-secret-not-on-disk");
    expect(await readFile(store.path, "utf8")).not.toContain("team-secret-not-on-disk");
    expect((await store.list("storage-team")).every((item) => !item.team)).toBe(true);
    expect((await api("DELETE", `/team:${id}`)).status).toBe(400);
  });
  test("retains a personal connector if publishing to the firm fails", async () => {
    const store = new StorageStore(config);
    const local = await store.save("storage-team", input());
    status = 403;
    expect((await api("POST", "/team", { localId: local.id })).status).toBe(403);
    expect((await store.get("storage-team", local.id)).secrets.password).toBe("team-secret-not-on-disk");
    status = 200;
    expect((await api("POST", "/team", { localId: local.id })).status).toBe(201);
    await expect(store.get("storage-team", local.id)).rejects.toThrow();
  });
});
