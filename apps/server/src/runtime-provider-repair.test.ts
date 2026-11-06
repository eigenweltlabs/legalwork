import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig, closeRuntimeOpencodeConfig, type RuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { providerRepairNotices, repairAllWorkspaceRuntimeProviders, repairRuntimeProviders, repairWorkspaceRuntimeProviders, resetProviderRepairNoticesForTests } from "./runtime-provider-repair.js";
import type { ServerConfig } from "./types.js";
import { nativeProviderDefinition } from "./opencode-model-config.js";

const nativeProvider = { package: "@opencode/ai/providers/openai-compatible", name: "Local gateway", settings: { baseURL: "http://localhost:11434/v1" }, models: { model: { name: "Model", limit: { context: 8192, output: 4096 } } } };
const retiredProvider = { ...nativeProvider, name: "Eigenwelt Free" };
let root = "", previousDb: string | undefined;
function serverConfig(): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [],
    workspaces: [{ id: "matter", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "legalwork-native-provider-validation-")); previousDb = process.env.LEGALWORK_RUNTIME_DB; process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite"); resetProviderRepairNoticesForTests(); });
afterEach(async () => { await closeRuntimeOpencodeConfig(serverConfig()); if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb; await rm(root, { recursive: true, force: true }); });

describe("native provider validation", () => {
  test("removes only the retired app provider and retains independent native connections", () => {
    const result = repairRuntimeProviders({ "eigenwelt-free": retiredProvider, local: nativeProvider });
    expect(result.providers).toEqual({ local: nativeProvider });
    expect(result.removed).toEqual([{ providerId: "eigenwelt-free", name: "Eigenwelt Free", reason: "retired" }]);
  });
  test("preserves native model-only overrides, optional limits, capability flags and variant arrays", () => {
    const provider = nativeProviderDefinition({ models: { model: { limit: { context: 128_000 }, capabilities: { temperature: false, reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] }, output: { limit: { output: 96_000 } } } });
    expect(repairRuntimeProviders({ openai: provider }).providers).toEqual({ openai: provider });
  });
  test("malformed native connections fail closed without removing or mutating their source", () => {
    for (const provider of ["not a block", { models: { model: "invalid" } }, { models: { model: { cost: { input: 1 } } } }, { models: { model: { capabilities: { input: [123] } } } }]) {
      const original = JSON.stringify(provider);
      expect(() => repairRuntimeProviders({ private: provider })).toThrow("has not removed the connection");
      expect(JSON.stringify(provider)).toBe(original);
    }
  });
  test("legacy provider syntax is rejected at runtime instead of guessed or silently converted", () => {
    expect(() => repairRuntimeProviders({ legacy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:7" } } })).toThrow("invalid native settings");
  });
  test("retired cleanup preserves native permission rules, MCP settings and unrelated providers", async () => {
    const config = serverConfig();
    const permissions = [{ action: "read", resource: "*", effect: "deny" }] satisfies NonNullable<RuntimeOpencodeConfig["permissions"]>;
    const mcp = { servers: { connector: { type: "remote", url: "https://example.invalid/mcp", disabled: true } } } satisfies NonNullable<RuntimeOpencodeConfig["mcp"]>;
    await writeRuntimeOpencodeConfig(config, "matter", () => ({ providers: { "eigenwelt-free": retiredProvider, local: nativeProvider }, permissions, mcp }));
    const notices = await repairWorkspaceRuntimeProviders(config, "matter");
    const stored = await readRuntimeOpencodeConfig(config, "matter");
    expect(stored.providers).toEqual({ local: nativeProvider }); expect(stored.permissions).toEqual(permissions); expect(stored.mcp).toEqual(mcp);
    expect(providerRepairNotices("matter")).toEqual(notices);
    expect(await repairWorkspaceRuntimeProviders(config, "matter")).toEqual([]); expect(providerRepairNotices("matter")).toHaveLength(1);
  });
  test("read-only startup leaves stored providers unchanged", async () => {
    const config = serverConfig();
    await writeRuntimeOpencodeConfig(config, "matter", () => ({ providers: { "eigenwelt-free": retiredProvider } }));
    await repairAllWorkspaceRuntimeProviders({ ...config, readOnly: true });
    expect((await readRuntimeOpencodeConfig(config, "matter")).providers).toEqual({ "eigenwelt-free": retiredProvider });
  });
});
