import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyEigenweltPaidManifestModels,
  applyEigenweltSystemOne,
  eigenweltPaidManifestRevision,
  parseManifestModels,
  readCachedEigenweltPaidManifest,
  refreshEigenweltPaidManifest,
  writeCachedEigenweltPaidManifest,
} from "./eigenwelt-paid-manifest.js";
import type { ServerConfig } from "./types.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";

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

test.each([false, true])("model refresh uses the saved region and rejects a concurrent firm switch (%s)", async (switchFirm) => {
  const config = await setup();
  const previousOverride = process.env.EIGENWELT_PLATFORM_URL;
  delete process.env.EIGENWELT_PLATFORM_URL;
  cleanups.push(() => {
    if (previousOverride === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
    else process.env.EIGENWELT_PLATFORM_URL = previousOverride;
  });
  const platformURL = "https://eu.platform.eigenweltlabs.com";
  await writeEigenweltConnection(config, { platformURL, platformToken: "eu-token" });
  await writeCachedEigenweltPaidManifest(config, { baseURL: `${platformURL}/v1`, apiKey: "eu-key", models: [EUROPE] });
  const originalFetch = globalThis.fetch;
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).toBe(`${platformURL}/api/desktop/models`);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer eu-token");
    expect(init?.redirect).toBe("error");
    if (switchFirm) await writeEigenweltConnection(config, { platformURL: "https://us.platform.eigenweltlabs.com", platformToken: "us-token" });
    return Response.json({ baseURL: `${platformURL}/v1`, models: [EUROPE, US] });
  }, { preconnect: originalFetch.preconnect }));
  cleanups.push(() => mock.mockRestore());
  if (switchFirm) await expect(refreshEigenweltPaidManifest(config)).rejects.toThrow("account changed during model refresh");
  else expect(await refreshEigenweltPaidManifest(config)).toEqual({ modelCount: 2, changed: true });
  expect((await readCachedEigenweltPaidManifest(config))?.models).toEqual(switchFirm ? [EUROPE] : [EUROPE, US]);
});

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

  test("keeps the gateway's output limit — dropping it here would put the model back on the default", () => {
    expect(
      parseManifestModels([
        { id: "gemini", contextLength: 1_048_576, maxOutputTokens: 65_536 },
        { id: "unknown", maxOutputTokens: "lots" },
      ]),
    ).toEqual([{ id: "gemini", contextLength: 1_048_576, maxOutputTokens: 65_536 }, { id: "unknown" }]);
  });

  test("keeps what a model reads, text first, and drops values the engine does not know", () => {
    expect(
      parseManifestModels([
        { id: "Eigenwelt Europe Gemini", inputModalities: ["pdf", "image", "text", "image"] },
        { id: "Eigenwelt Europe GLM", inputModalities: ["image", "video", 42] },
        { id: "Eigenwelt Europe DeepSeek", inputModalities: [] },
        { id: "junk", inputModalities: "image" },
      ]),
    ).toEqual([
      { id: "Eigenwelt Europe Gemini", inputModalities: ["text", "image", "pdf"] },
      { id: "Eigenwelt Europe GLM", inputModalities: ["text", "image"] },
      { id: "Eigenwelt Europe DeepSeek", inputModalities: ["text"] },
      { id: "junk" },
    ]);
  });
});

describe("applyEigenweltPaidManifestModels", () => {
  test("renames a model around its existing ID and key, so saved selections remain valid", async () => {
    const config = await setup();
    const original = { id: "Eigenwelt Europe Gemini", name: "Eigenwelt Europe Gemini", region: "EU" };
    await writeCachedEigenweltPaidManifest(config, {
      baseURL: "https://gateway.test/v1", apiKey: "existing-firm-key", models: [original],
    });
    const renamed = { ...original, name: "Gemini 3.8 Flash (EU)" };
    const argon = { id: "gemini-4-argon-eu", name: "Gemini 4 Argon (EU)", region: "EU" };
    expect(await applyEigenweltPaidManifestModels(config, [renamed, argon])).toBe(true);
    const cached = await readCachedEigenweltPaidManifest(config);
    expect(cached).toMatchObject({ apiKey: "existing-firm-key", models: [renamed, argon] });
    expect(cached?.models.find((model) => model.id === original.id)?.name).toBe(renamed.name);
    expect(await applyEigenweltPaidManifestModels(config, [renamed, argon])).toBe(false);
  });
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


test("SystemOne metadata survives model refresh with the same subscription key, and older payloads stay compatible", async () => {
  const config = await setup();
  const systemOne = { enabled: true, available: true, baseURL: "https://api.eigenweltlabs.com", model: "EigenJev", region: "EU", questionTypes: ["noul", "choice", "score"] };
  await applyEigenweltSystemOne(config, systemOne);
  expect(await readCachedEigenweltPaidManifest(config)).toBeNull();
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://chat.test/v1", apiKey: "same-subscription-key", models: [EUROPE] });
  await applyEigenweltSystemOne(config, systemOne);
  await applyEigenweltPaidManifestModels(config, [US]);
  await applyEigenweltSystemOne(config, undefined);
  expect(await readCachedEigenweltPaidManifest(config)).toMatchObject({ apiKey: "same-subscription-key", models: [US], systemOne });
});
