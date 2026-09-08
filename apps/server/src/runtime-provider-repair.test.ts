import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLegalworkRuntimeConfigObject } from "./legalwork-runtime-config.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import {
  providerRepairNotices,
  repairAllWorkspaceRuntimeProviders,
  repairRuntimeProviders,
  repairWorkspaceRuntimeProviders,
  resetProviderRepairNoticesForTests,
} from "./runtime-provider-repair.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_repair_test";

// The shape the custom-provider form used to write for the free tier: a
// `limit` with `context` only, which the engine rejects for the whole file.
const STALE_FREE_BLOCK = {
  npm: "@ai-sdk/openai-compatible",
  name: "Eigenwelt Free",
  options: { baseURL: "https://free.gateway.test/v1" },
  models: {
    "deepseek-v4-flash": { name: "deepseek-v4-flash", tool_call: true, limit: { context: 128000 } },
    "gemini-flash-latest": { name: "gemini-flash-latest", tool_call: true, limit: { context: 1000000 } },
  },
};

const LOCAL_BLOCK = {
  npm: "@ai-sdk/openai-compatible",
  name: "Ollama",
  options: { baseURL: "http://localhost:11434/v1" },
  models: { "llama3": { name: "llama3", limit: { context: 8192, output: 4096 } } },
};

let root = "";
let previousDb: string | undefined;

function serverConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "legalwork-provider-repair-"));
  previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  resetProviderRepairNoticesForTests();
});

afterEach(async () => {
  if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousDb;
  await rm(root, { recursive: true, force: true });
});

describe("repairRuntimeProviders", () => {
  test("drops the retired free provider and reports its display name", () => {
    const result = repairRuntimeProviders({ "eigenwelt-free": STALE_FREE_BLOCK, ollama: LOCAL_BLOCK });
    expect(Object.keys(result.providers)).toEqual(["ollama"]);
    expect(result.removed).toEqual([{ providerId: "eigenwelt-free", name: "Eigenwelt Free", reason: "retired" }]);
  });

  test("drops a provider whose model limit lacks output (the engine rejects the whole file)", () => {
    const broken = { ...LOCAL_BLOCK, name: "", models: { llama3: { name: "llama3", limit: { context: 8192 } } } };
    const result = repairRuntimeProviders({ ollama: broken });
    expect(result.providers).toEqual({});
    expect(result.removed).toEqual([{ providerId: "ollama", name: "ollama", reason: "invalid" }]);
  });

  test("keeps valid blocks, including ones without models or limits", () => {
    const result = repairRuntimeProviders({
      ollama: LOCAL_BLOCK,
      bare: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://x" } },
      nolimit: { models: { m: { name: "m", tool_call: false, reasoning: true } } },
    });
    expect(Object.keys(result.providers)).toEqual(["ollama", "bare", "nolimit"]);
    expect(result.removed).toEqual([]);
  });

  test("rejects non-object blocks and wrong field types", () => {
    const result = repairRuntimeProviders({
      text: "not a block",
      badModels: { models: { m: "nope" } },
      badCost: { models: { m: { cost: { input: 1 } } } },
    });
    expect(result.providers).toEqual({});
    expect(result.removed.map((item) => item.reason)).toEqual(["invalid", "invalid", "invalid"]);
  });
});

describe("repairWorkspaceRuntimeProviders", () => {
  test("rewrites the stored row without the bad block, keeps everything else, and records a notice", async () => {
    const config = serverConfig();
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      mcp: { notion: { type: "remote", url: "https://mcp.notion.test" } },
      provider: { "eigenwelt-free": STALE_FREE_BLOCK, ollama: LOCAL_BLOCK },
    }));

    const removed = await repairWorkspaceRuntimeProviders(config, WORKSPACE_ID);
    expect(removed.map((item) => item.providerId)).toEqual(["eigenwelt-free"]);

    const stored = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
    expect(Object.keys(stored.provider ?? {})).toEqual(["ollama"]);
    expect(stored.mcp).toEqual({ notion: { type: "remote", url: "https://mcp.notion.test" } });
    expect(providerRepairNotices(WORKSPACE_ID)).toEqual(removed);

    // Clean row: nothing to do, and no duplicate notices.
    expect(await repairWorkspaceRuntimeProviders(config, WORKSPACE_ID)).toEqual([]);
    expect(providerRepairNotices(WORKSPACE_ID)).toHaveLength(1);
  });

  test("startup pass skips read-only servers", async () => {
    const config = { ...serverConfig(), readOnly: true };
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      provider: { "eigenwelt-free": STALE_FREE_BLOCK },
    }));
    await repairAllWorkspaceRuntimeProviders(config);
    const stored = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
    expect(Object.keys(stored.provider ?? {})).toEqual(["eigenwelt-free"]);
    expect(providerRepairNotices(WORKSPACE_ID)).toEqual([]);
  });
});

describe("engine config build", () => {
  test("never passes a stale or unparsable stored provider to the engine, even before the startup repair ran", async () => {
    const config = serverConfig();
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      provider: { "eigenwelt-free": STALE_FREE_BLOCK, ollama: LOCAL_BLOCK },
    }));

    const built = await buildLegalworkRuntimeConfigObject(config, WORKSPACE_ID);
    expect(built.provider).toEqual({ ollama: LOCAL_BLOCK });
  });
});
