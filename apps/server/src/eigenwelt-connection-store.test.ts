import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readEigenweltConnection,
  readEigenweltEntitlementsView,
  writeEigenweltConnection,
} from "./eigenwelt-connection-store.js";
import type { ServerConfig } from "./types.js";

const previousRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;
const previousPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (previousRuntimeDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousRuntimeDb;
  if (previousPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = previousPlatformUrl;
});

function serverConfig(root: string): ServerConfig {
  return {
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
}

async function setup(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-conn-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.EIGENWELT_PLATFORM_URL = "https://platform.eigenweltlabs.com";
  return serverConfig(root);
}

const ENTITLEMENTS = {
  plan: "pro" as const,
  subscriptionStatus: "active",
  features: ["admin_hub", "settings_presets"],
  seats: 5,
  usage: { dailyAllowanceCents: 5000, dailyRemainingCents: 4000, dailyUsedPercent: 20, extraUsageEnabled: false, prepaidBalanceCents: 0 },
};

const ACCOUNT = {
  userId: "user_123",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  orgId: "org_123",
  orgName: "Analytical Engine LLP",
};

describe("eigenwelt-connection-store", () => {
  test("persists entitlements + platformURL + secret token; the public view omits the token", async () => {
    const config = await setup();
    await writeEigenweltConnection(config, "ws_1", {
      account: ACCOUNT,
      entitlements: ENTITLEMENTS,
      platformURL: "https://platform.eigenweltlabs.com/",
      platformToken: "plat_secret_123",
    });

    const full = await readEigenweltConnection(config, "ws_1");
    expect(full.platformToken).toBe("plat_secret_123");
    expect(full.platformURL).toBe("https://platform.eigenweltlabs.com"); // trailing slash trimmed
    expect(full.entitlements).toEqual(ENTITLEMENTS);
    expect(full.account).toEqual(ACCOUNT);

    const view = await readEigenweltEntitlementsView(config, "ws_1");
    expect(view.entitlements).toEqual(ENTITLEMENTS);
    expect(view.account).toEqual(ACCOUNT);
    expect(view.platformURL).toBe("https://platform.eigenweltlabs.com");
    expect(view.connected).toBe(true);
    expect("platformToken" in view).toBe(false);
  });

  test("rejects a platform URL outside the configured trusted origin", async () => {
    const config = await setup();
    await expect(writeEigenweltConnection(config, "ws_1", {
      platformURL: "http://127.0.0.1:8080/internal",
      platformToken: "attacker-controlled",
    })).rejects.toThrow("does not match");
  });

  test("connected is false with no stored account; true once a token is stored", async () => {
    const config = await setup();
    // Nothing stored yet — not signed in (and links fall back to the origin).
    const before = await readEigenweltEntitlementsView(config, "ws_1");
    expect(before.connected).toBe(false);
    expect(before.entitlements).toBeNull();

    // A sign-in with only a token (zero models / no entitlements) still counts
    // as connected — login is independent of the served model list.
    await writeEigenweltConnection(config, "ws_1", { platformToken: "plat_only" });
    const after = await readEigenweltEntitlementsView(config, "ws_1");
    expect(after.connected).toBe(true);
  });

  test("persists + reads back the refresh token and access-token expiry", async () => {
    const config = await setup();
    await writeEigenweltConnection(config, "ws_1", {
      platformToken: "access_v1",
      refreshToken: "refresh_v1",
      accessTokenExpiresAt: 1_800_000,
    });
    const full = await readEigenweltConnection(config, "ws_1");
    expect(full.platformToken).toBe("access_v1");
    expect(full.refreshToken).toBe("refresh_v1");
    expect(full.platformTokenExpiresAt).toBe(1_800_000);

    // A refresh rotates access+refresh+expiry without touching entitlements.
    await writeEigenweltConnection(config, "ws_1", {
      platformToken: "access_v2",
      refreshToken: "refresh_v2",
      accessTokenExpiresAt: 3_600_000,
    });
    const rotated = await readEigenweltConnection(config, "ws_1");
    expect(rotated.platformToken).toBe("access_v2");
    expect(rotated.refreshToken).toBe("refresh_v2");
    expect(rotated.platformTokenExpiresAt).toBe(3_600_000);

    // Signed in via refresh token even with no access token yet.
    await writeEigenweltConnection(config, "ws_1", { platformToken: null });
    const view = await readEigenweltEntitlementsView(config, "ws_1");
    expect(view.connected).toBe(true);
  });

  test("returns empty connection for an unknown workspace", async () => {
    const config = await setup();
    expect(await readEigenweltConnection(config, "nope")).toEqual({
      entitlements: null,
      account: null,
      platformURL: null,
      platformToken: null,
      refreshToken: null,
      platformTokenExpiresAt: null,
    });
  });

  test("partial writes preserve untouched fields; a rotated token overwrites", async () => {
    const config = await setup();
    await writeEigenweltConnection(config, "ws_1", {
      account: ACCOUNT,
      entitlements: ENTITLEMENTS,
      platformURL: "https://platform.eigenweltlabs.com",
      platformToken: "token_v1",
    });
    // Re-connect delivers a rotated token only; entitlements/URL untouched.
    await writeEigenweltConnection(config, "ws_1", { platformToken: "token_v2" });

    const full = await readEigenweltConnection(config, "ws_1");
    expect(full.platformToken).toBe("token_v2");
    expect(full.platformURL).toBe("https://platform.eigenweltlabs.com");
    expect(full.entitlements).toEqual(ENTITLEMENTS);
    expect(full.account).toEqual(ACCOUNT);
  });
});
