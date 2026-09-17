import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { readFreshEntitlementsView } from "./eigenwelt-refresh.js";
import type { ServerConfig } from "./types.js";

/**
 * Offline, or with the platform down, a signed-in firm stays signed in on its
 * last known plan, so the app keeps its models instead of showing the sign-in
 * screen. Only the platform rejecting the refresh token signs the device out.
 */

const previousPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const previousRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (previousPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = previousPlatformUrl;
  if (previousRuntimeDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousRuntimeDb;
});

async function signedInFirm(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-refresh-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
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
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
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
    expect(view.account?.orgName).toBe("Kanzlei Berg");
    expect(view.entitlements?.features).toContain("premium_models");
  });

  test("a platform error keeps the firm signed in too", async () => {
    const config = await signedInFirm();
    process.env.EIGENWELT_PLATFORM_URL = await platformAnswering(503);
    const view = await readFreshEntitlementsView(config);
    expect(view.connected).toBe(true);
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
