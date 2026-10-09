import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { readEigenweltConnection, writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { ensureFreshPlatformToken, readFreshEntitlementsView, revokeEigenweltConnection } from "./eigenwelt-refresh.js";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readCachedEigenweltPaidManifest, writeCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import type { ServerConfig } from "./types.js";

/**
 * Offline, or with the platform down, a signed-in firm stays signed in on its
 * last known plan, so the app keeps its models instead of showing the sign-in
 * screen. Only the platform rejecting the refresh token signs the device out.
 */

const previousPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (previousPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = previousPlatformUrl;
});

async function signedInFirm(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-refresh-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  // Its own runtime DB through the config, not the process environment: a server another
  // test left running must not read this account and refresh it against another platform.
  const config: ServerConfig = {
    configPath: join(root, "server.json"),
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  await writeEigenweltConnection(config, {
    entitlements: parseEigenweltEntitlements({
      plan: "plus",
      subscriptionStatus: "active",
      features: ["premium_models"],
      seats: 1,
      usage: { window: "week", allowanceCents: 693, remainingCents: 693 },
    }),
    account: { userId: "user_1", userName: null, userEmail: "anna@kanzlei.de", orgId: "org_1", orgName: "Kanzlei Berg" },
    platformToken: "access-token",
    refreshToken: "refresh-token",
    // Expired, so the next read tries to refresh.
    accessTokenExpiresAt: Date.now() - 1_000,
  });
  return config;
}

/** A platform whose refresh endpoint always answers with `status`. */
async function platformAnswering(status: number): Promise<string> {
  const server: Server = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "refused" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("platform failed to bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("the Eigenwelt account when the platform cannot be reached", () => {
  test("offline, the firm stays signed in on its last plan", async () => {
    const config = await signedInFirm();
    // Nothing listens here: the refresh fails like it does without a network.
    process.env.EIGENWELT_PLATFORM_URL = "http://127.0.0.1:1";
    const view = await readFreshEntitlementsView(config);
    expect(view.connected).toBe(true);
    expect(view.reconnecting).toBe(true);
    expect(view.account?.orgName).toBe("Kanzlei Berg");
    expect(view.entitlements?.features).toContain("premium_models");
  });

  test("a platform error keeps the firm signed in too", async () => {
    const config = await signedInFirm();
    process.env.EIGENWELT_PLATFORM_URL = await platformAnswering(503);
    const view = await readFreshEntitlementsView(config);
    expect(view.connected).toBe(true);
    expect(view.reconnecting).toBe(true);
    expect(view.entitlements?.subscriptionStatus).toBe("active");
  });

  test("only a rejected refresh token signs the device out", async () => {
    const config = await signedInFirm();
    process.env.EIGENWELT_PLATFORM_URL = await platformAnswering(401);
    const view = await readFreshEntitlementsView(config);
    expect(view.connected).toBe(false);
    expect(view.account).toBeNull();
  });
});

/** Regression tests use real HTTP and SQLite, including a fresh runtime process. */
describe("interrupted and delayed refresh recovery", () => {
  async function serve(handler: RequestListener): Promise<string> {
    const server = createServer((req, res) => {
      // Other server fixtures can still be fetching their model lists. Only
      // refresh/revoke requests belong to this test's scripted auth exchange.
      if (req.method !== "POST" || (req.url !== "/api/desktop/refresh" && req.url !== "/api/desktop/revoke")) {
        req.resume();
        res.writeHead(404).end();
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    return `http://127.0.0.1:${address.port}`;
  }
  const rotated = () => ({ platformToken: "rotated-access", refreshToken: "rotated-refresh",
    accessTokenExpiresAt: Date.now() + 900_000 });

  test("recovers a lost response using the persisted request ID after a runtime restart", async () => {
    const config = await signedInFirm();
    const requestIds: string[] = [];
    let recovering = false;
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body: unknown = JSON.parse(raw);
        if (!body || typeof body !== "object" || !("requestId" in body) || typeof body.requestId !== "string") {
          res.writeHead(400).end(); return;
        }
        requestIds.push(body.requestId);
        if (!recovering) {
          // A socket closed before any response can be retried transparently by fetch.
          // Deliver a partial response to model a lost rotation result deterministically.
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
          res.write('{"platformToken":');
          setTimeout(() => res.destroy(), 10);
        }
        else if (body.requestId === requestIds[0]) res.writeHead(200).end(JSON.stringify(rotated()));
        else res.writeHead(401).end();
      });
    });
    const unrelated = await fetch(`${process.env.EIGENWELT_PLATFORM_URL}/api/public/models`);
    expect(unrelated.status).toBe(404);
    expect(requestIds).toEqual([]);
    const first = await readFreshEntitlementsView(config);
    expect(first.connected).toBe(true);
    expect(first.reconnecting).toBe(true);
    const pending = await readEigenweltConnection(config);
    expect(pending.refreshRequestId).toBe(requestIds[0]);
    expect("refreshRequestId" in first).toBe(false);
    const module = pathToFileURL(join(import.meta.dir, "eigenwelt-refresh.ts")).href;
    recovering = true;
    const child = Bun.spawn([process.execPath, "-e", `import { readFreshEntitlementsView } from ${JSON.stringify(module)};
      console.log(JSON.stringify(await readFreshEntitlementsView(${JSON.stringify(config)})));`],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const errors = await new Response(child.stderr).text();
    expect({ output: JSON.parse(output), errors }).toMatchObject({ output: { connected: true }, errors: "" });
    if (!pending.refreshRequestId) throw new Error("request ID not persisted");
    expect(requestIds.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(requestIds)]).toEqual([pending.refreshRequestId]);
    const recovered = await readEigenweltConnection(config);
    expect(recovered.refreshToken).toBe("rotated-refresh");
    expect(recovered.refreshRequestId).toBeNull();
    expect(recovered.refreshError).toBeNull();
    expect(recovered.entitlements?.subscriptionStatus).toBe("active");
  });

  test("a failed local save retains the request ID and retries the same rotation", async () => {
    const config = await signedInFirm();
    if (!config.configPath) throw new Error("test config path missing");
    const sqlite = new Database(join(dirname(config.configPath), "runtime.sqlite"));
    cleanups.push(() => sqlite.close());
    sqlite.run(`CREATE TRIGGER fail_refresh_save BEFORE UPDATE ON eigenwelt_connections
      WHEN NEW.refresh_token = 'rotated-refresh' BEGIN SELECT RAISE(ABORT, 'simulated save failure'); END`);
    const ids: string[] = [];
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      let raw = ""; req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body: unknown = JSON.parse(raw);
        if (body && typeof body === "object" && "requestId" in body && typeof body.requestId === "string") ids.push(body.requestId);
        res.writeHead(200).end(JSON.stringify(rotated()));
      });
    });
    const first = await readFreshEntitlementsView(config);
    expect(first.connected).toBe(true);
    expect(first.reconnecting).toBe(true);
    expect((await readEigenweltConnection(config)).refreshToken).toBe("refresh-token");
    sqlite.run("DROP TRIGGER fail_refresh_save");
    expect((await readFreshEntitlementsView(config)).reconnecting).toBeUndefined();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect((await readEigenweltConnection(config)).refreshToken).toBe("rotated-refresh");
  });

  test("an old rejection preserves a newer successful sign-in", async () => {
    const config = await signedInFirm();
    let release: () => void = () => { throw new Error("request not started"); };
    let started: () => void = () => {};
    const received = new Promise<void>(resolve => { started = resolve; });
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); release = () => res.writeHead(401).end("unauthorized"); started();
    });
    const pending = readFreshEntitlementsView(config);
    await received;
    await writeEigenweltConnection(config, {
      platformToken: "new-sign-in-access", refreshToken: "new-sign-in-refresh",
      accessTokenExpiresAt: Date.now() + 900_000,
    });
    release();
    expect((await pending).connected).toBe(true);
    expect((await readEigenweltConnection(config)).refreshToken).toBe("new-sign-in-refresh");
  });

  test("an old successful response cannot restore a signed-out account or manifest", async () => {
    const config = await signedInFirm();
    await writeCachedEigenweltPaidManifest(config, { baseURL: "https://models.eigenweltlabs.com", apiKey: "paid-key", models: [] });
    let release: () => void = () => { throw new Error("request not started"); };
    let started: () => void = () => {};
    const received = new Promise<void>(resolve => { started = resolve; });
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume();
      if (req.url === "/api/desktop/revoke") { res.writeHead(204).end(); return; }
      release = () => res.writeHead(200).end(JSON.stringify({ ...rotated(), models: [{ id: "stale-model", name: "Stale" }] }));
      started();
    });
    const pending = readFreshEntitlementsView(config);
    await received;
    await revokeEigenweltConnection(config);
    release();
    expect((await pending).connected).toBe(false);
    expect((await readEigenweltConnection(config)).refreshToken).toBeNull();
    expect(await readCachedEigenweltPaidManifest(config)).toBeNull();
  });

  test("a newer sign-in can refresh while an old request is still in flight", async () => {
    const config = await signedInFirm();
    let release: () => void = () => { throw new Error("request not started"); };
    let started: () => void = () => {};
    const received = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); calls++;
      if (calls === 1) { release = () => res.writeHead(401).end(); started(); }
      else res.writeHead(200).end(JSON.stringify(rotated()));
    });
    const old = ensureFreshPlatformToken(config);
    await received;
    await writeEigenweltConnection(config, { platformToken: "new-access", refreshToken: "new-refresh", accessTokenExpiresAt: 1 });
    expect(await ensureFreshPlatformToken(config)).toBe("rotated-access");
    release();
    expect(await old).toBe("rotated-access");
    expect(calls).toBe(2);
  });

  test("local sign-out happens before a slow remote revoke and cannot erase a later sign-in", async () => {
    const config = await signedInFirm();
    let release: () => void = () => { throw new Error("request not started"); };
    let started: () => void = () => {};
    const received = new Promise<void>(resolve => { started = resolve; });
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); release = () => res.writeHead(204).end(); started();
    });
    const signout = revokeEigenweltConnection(config);
    await received;
    expect((await readEigenweltConnection(config)).refreshToken).toBeNull();
    await writeEigenweltConnection(config, { platformToken: "new-access", refreshToken: "new-refresh" });
    release(); await signout;
    expect((await readEigenweltConnection(config)).refreshToken).toBe("new-refresh");
  });

  test("concurrent callers share one request, while different runtime databases refresh independently", async () => {
    const first = await signedInFirm();
    const second = await signedInFirm();
    let calls = 0;
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); calls++;
      setTimeout(() => res.writeHead(200).end(JSON.stringify(rotated())), 30);
    });
    await Promise.all(Array.from({ length: 5 }, () => ensureFreshPlatformToken(first)));
    expect(calls).toBe(1);
    await writeEigenweltConnection(first, { accessTokenExpiresAt: 1 });
    await Promise.all([ensureFreshPlatformToken(first), ensureFreshPlatformToken(second)]);
    expect(calls).toBe(3);
    expect((await readEigenweltConnection(second)).refreshToken).toBe("rotated-refresh");
  });

  test("a pending forced refresh retries even while the previous access token is still valid", async () => {
    const config = await signedInFirm();
    await writeEigenweltConnection(config, { accessTokenExpiresAt: Date.now() + 900_000 });
    let calls = 0;
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); calls++;
      res.writeHead(calls === 1 ? 503 : 200).end(JSON.stringify(rotated()));
    });
    expect((await readFreshEntitlementsView(config, { force: true })).reconnecting).toBe(true);
    expect((await readFreshEntitlementsView(config)).reconnecting).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("an invalid successful response preserves the pending retry and paid account", async () => {
    const config = await signedInFirm();
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); res.writeHead(200).end(JSON.stringify({ refreshToken: "incomplete" }));
    });
    const view = await readFreshEntitlementsView(config);
    expect(view.connected).toBe(true);
    expect(view.reconnecting).toBe(true);
    expect((await readEigenweltConnection(config)).refreshRequestId).toBeTruthy();
  });

  test("an untrusted optional URL cannot discard valid rotated credentials", async () => {
    const config = await signedInFirm();
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); res.writeHead(200).end(JSON.stringify({ ...rotated(), platformURL: "https://attacker.example" }));
    });
    expect((await readFreshEntitlementsView(config)).connected).toBe(true);
    expect((await readEigenweltConnection(config)).refreshToken).toBe("rotated-refresh");
  });

  test("a hanging response body times out, retaining a recoverable request", async () => {
    const config = await signedInFirm();
    process.env.EIGENWELT_PLATFORM_URL = await serve((req, res) => {
      req.resume(); res.writeHead(200); res.write('{"platformToken":');
    });
    const timeout = AbortSignal.timeout;
    const mock = spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(30));
    try {
      const view = await readFreshEntitlementsView(config);
      expect(view.connected).toBe(true);
      expect(view.reconnecting).toBe(true);
      expect((await readEigenweltConnection(config)).refreshRequestId).toBeTruthy();
    } finally { mock.mockRestore(); }
  });
});
