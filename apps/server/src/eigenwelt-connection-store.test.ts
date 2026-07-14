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
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (previousRuntimeDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousRuntimeDb;
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
  return serverConfig(root);
}

const ENTITLEMENTS = {
  plan: "pro" as const,
  subscriptionStatus: "active",
  features: ["admin_hub", "settings_presets"],
  seats: 5,
  usage: { dailyAllowanceCents: 5000, dailyRemainingCents: 4000, extraUsageEnabled: false, prepaidBalanceCents: 0 },
};

describe("eigenwelt-connection-store", () => {
  test("persists entitlements + platformURL + secret token; the public view omits the token", async () => {
    const config = await setup();
    await writeEigenweltConnection(config, "ws_1", {
      entitlements: ENTITLEMENTS,
      platformURL: "https://platform.eigenweltlabs.com/",
      platformToken: "plat_secret_123",
    });

    const full = await readEigenweltConnection(config, "ws_1");
    expect(full.platformToken).toBe("plat_secret_123");
    expect(full.platformURL).toBe("https://platform.eigenweltlabs.com"); // trailing slash trimmed
    expect(full.entitlements).toEqual(ENTITLEMENTS);

    const view = await readEigenweltEntitlementsView(config, "ws_1");
    expect(view.entitlements).toEqual(ENTITLEMENTS);
    expect(view.platformURL).toBe("https://platform.eigenweltlabs.com");
    expect("platformToken" in view).toBe(false);
  });

  test("returns empty connection for an unknown workspace", async () => {
    const config = await setup();
    expect(await readEigenweltConnection(config, "nope")).toEqual({
      entitlements: null,
      platformURL: null,
      platformToken: null,
    });
  });

  test("partial writes preserve untouched fields; a rotated token overwrites", async () => {
    const config = await setup();
    await writeEigenweltConnection(config, "ws_1", {
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
  });
});
