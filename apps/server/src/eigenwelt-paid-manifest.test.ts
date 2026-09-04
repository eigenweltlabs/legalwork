import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyEigenweltPaidManifestModels,
  eigenweltPaidManifestRevision,
  parseManifestModels,
  readCachedEigenweltPaidManifest,
  writeCachedEigenweltPaidManifest,
} from "./eigenwelt-paid-manifest.js";
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
  const root = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-manifest-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return serverConfig(root);
}

const EUROPE = { id: "Eigenwelt Europe", name: "Eigenwelt Europe", region: "EU", hostedIn: "Europe" };
const US = { id: "Eigenwelt US", name: "Eigenwelt US", region: "US", hostedIn: "United States" };

describe("parseManifestModels", () => {
  test("keeps the hosting facts and drops malformed entries", () => {
    expect(
      parseManifestModels([
        { id: "Eigenwelt Europe", name: "Eigenwelt Europe", region: "EU", hostedIn: " Europe ", upstreamModel: "DeepSeek V4 Flash", description: "" },
        { id: "", name: "nameless" },
        "junk",
        { id: "plain" },
      ]),
    ).toEqual([
      { id: "Eigenwelt Europe", name: "Eigenwelt Europe", region: "EU", hostedIn: "Europe", upstreamModel: "DeepSeek V4 Flash" },
      { id: "plain" },
    ]);
  });
});

describe("applyEigenweltPaidManifestModels", () => {
  test("is a no-op without a cached manifest (not signed in)", async () => {
    const config = await setup();
    expect(await applyEigenweltPaidManifestModels(config, [EUROPE])).toBe(false);
    expect(await readCachedEigenweltPaidManifest(config)).toBeNull();
  });

  test("replaces the cached list around the kept key only when it differs", async () => {
    const config = await setup();
    await writeCachedEigenweltPaidManifest(config, {
      baseURL: "https://gateway.test/v1",
      apiKey: "ewl_key",
      models: [EUROPE, US],
    });
    // The admin turned the US model off on the platform.
    expect(await applyEigenweltPaidManifestModels(config, [EUROPE])).toBe(true);
    expect(await readCachedEigenweltPaidManifest(config)).toEqual({
      baseURL: "https://gateway.test/v1",
      apiKey: "ewl_key",
      models: [EUROPE],
    });
    expect(await applyEigenweltPaidManifestModels(config, [EUROPE])).toBe(false);
  });
});

describe("eigenweltPaidManifestRevision", () => {
  test("is null when not connected, stable across order, and moves with the model set", () => {
    expect(eigenweltPaidManifestRevision(null)).toBeNull();
    const base = { baseURL: "https://gateway.test/v1", apiKey: "k" };
    const both = eigenweltPaidManifestRevision({ ...base, models: [EUROPE, US] });
    expect(eigenweltPaidManifestRevision({ ...base, models: [US, EUROPE] })).toBe(both);
    expect(eigenweltPaidManifestRevision({ ...base, models: [EUROPE] })).not.toBe(both);
    // The key is not part of the fingerprint: a rotated key is not a model change.
    expect(eigenweltPaidManifestRevision({ ...base, apiKey: "other", models: [EUROPE, US] })).toBe(both);
  });
});
