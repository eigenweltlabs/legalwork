import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { buildOrgPolicyEngineLayerFor, legalworkRuntimeConfigFilePath, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { appliedOrgPolicy, releaseOrgPolicyKey, requireOrgPolicyUnmanaged, resetOrgPolicyRuntimeForTests, scheduleOrgPolicySync } from "./org-policy.js";
import { orgPolicyEngineDir, orgPolicyEngineLayerIntact } from "./org-policy-engine.js";
import { LegalWorkOrgPolicyGuard } from "./opencode-plugins/legalwork-org-policy-guard.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { OcrManager } from "./ocr/manager.js";
import { saveSystemOneProvider } from "./systemone.js";
import { requireConnectorAllowed, requireHubInstallAllowed } from "./org-policy-items.js";
import { ReviewDefaults } from "./reviews/storage.js";

const realFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  setSystemTime();
  while (cleanups.length) await cleanups.pop()?.();
});

function fakeFetch(handler: (url: string) => Response) {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => handler(String(input)), { preconnect: realFetch.preconnect });
}

async function setup(entries: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-org-policy-engine-"));
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config = {
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
  } as unknown as ServerConfig;
  cleanups.push(async () => {
    resetOrgPolicyRuntimeForTests(config);
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
    else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  });
  fakeFetch((url) =>
    url.endsWith("/api/desktop/policy")
      ? Response.json({ schemaVersion: 1, orgId: "org_kanzlei", orgName: "Kanzlei", revision: 1, role: "member", updatedAt: null, entries })
      : new Response(null, { status: 404 }),
  );
  await writeEigenweltConnection(config, {
    platformToken: "tok",
    platformURL: eigenweltPlatformUrl(),
    account: { userId: "u", userName: "Anna", userEmail: null, orgId: "org_kanzlei", orgName: "Kanzlei" },
  });
  await scheduleOrgPolicySync(config, { force: true });
  return { config, root };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("the firm's tool permissions in the engine", () => {
  test("enforced rules are the minimum and go to the firm's own config folder", async () => {
    const { config } = await setup({ "tools.permissions": { mode: "enforced", value: { bash: "ask", edit: "ask" } } });
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({
      permission: { bash: "deny", edit: "allow", webfetch: "allow" },
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");

    const runtime = await readJson(legalworkRuntimeConfigFilePath(config));
    // The member's stricter bash rule stays; edit follows the firm.
    expect(runtime.permission).toMatchObject({ bash: "deny", edit: "ask", webfetch: "allow" });
    const layer = await readJson(join(orgPolicyEngineDir(config), "opencode.json"));
    expect(layer).toEqual({
      // Already there, so the engine never rewrites the file to add it.
      $schema: "https://opencode.ai/config.json",
      permission: { bash: "deny", edit: "ask" },
      agent: { legalwork: { permission: { bash: "deny", edit: "ask" } } },
    });
    expect(await orgPolicyEngineLayerIntact(config, await buildOrgPolicyEngineLayerFor(config, "ws_1"))).toBe(true);
  });

  test("after sign-out, rules the member takes back stop applying", async () => {
    const { config } = await setup({ "tools.permissions": { mode: "enforced", value: { edit: "deny" } } });
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { edit: "allow" } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).permission).toMatchObject({ edit: "deny" });

    await writeEigenweltConnection(config, { platformToken: null, account: null, platformURL: null });
    await scheduleOrgPolicySync(config, { force: true });
    await releaseOrgPolicyKey(config, "tools.permissions");
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).permission).toMatchObject({ edit: "allow" });
    expect(await readJson(join(orgPolicyEngineDir(config), "opencode.json"))).toEqual({ $schema: "https://opencode.ai/config.json" });
  });
});

describe("the guard plugin", () => {
  test("refuses what the firm denies, and calls it covers while the engine's rules are looser", async () => {
    process.env.LEGALWORK_SERVER_URL = "http://legalwork.test";
    let guard: Record<string, unknown> = { orgName: "Kanzlei", permission: { bash: { "*": "ask", "rm *": "deny" }, edit: "ask" }, blockedMcpServers: ["crm"] };
    fakeFetch((url) => (url.endsWith("/org-policy/guard") ? Response.json(guard) : new Response(null, { status: 404 })));
    let engine: Record<string, unknown> = { permission: { bash: { "*": "ask", "rm *": "deny" }, edit: "ask" } };
    // Like the engine's SDK: its methods read their own `this`.
    class SdkConfig {
      private readonly source = () => engine;
      async get() {
        return { data: this.source() };
      }
    }
    const hooks = await LegalWorkOrgPolicyGuard({ client: { config: new SdkConfig() } });
    const call = (tool: string, args: Record<string, unknown>) => hooks["tool.execute.before"]({ tool }, { args });

    await call("bash", { command: "ls -la" });
    await call("read", { filePath: "/x" });
    await expect(call("bash", { command: "rm -rf /" })).rejects.toThrow("Kanzlei does not allow");
    await expect(call("crm_search", {})).rejects.toThrow('the connector "crm"');

    // A project file loosened the engine's rules: refused until restored.
    setSystemTime(new Date(Date.now() + 10_000));
    engine = { permission: { bash: "allow", edit: "ask" } };
    await expect(call("bash", { command: "ls" })).rejects.toThrow("until its settings are restored");
    await call("edit", { filePath: "/x" });

    // Nothing enforced: everything goes through.
    setSystemTime(new Date(Date.now() + 20_000));
    guard = { orgName: "Kanzlei", permission: {}, blockedMcpServers: [] };
    await call("bash", { command: "rm -rf /" });
  });
});

describe("the firm's switches for members' own providers and connectors", () => {
  const entries = {
    "ai.chat.allowCustom": { mode: "enforced", value: false },
    "ai.systemOne.allowCustom": { mode: "enforced", value: false },
    "ai.ocr.allowCustom": { mode: "enforced", value: false },
    "connectors.allowCustom": { mode: "enforced", value: false },
  };

  test("chat: the engine enables only Eigenwelt's provider", async () => {
    const { config } = await setup(entries);
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(join(orgPolicyEngineDir(config), "opencode.json"))).enabled_providers).toEqual(["eigenwelt"]);
  });

  test("SystemOne and OCR refuse own providers", async () => {
    const { config, root } = await setup(entries);
    await expect(saveSystemOneProvider(config, { id: "mine", name: "Mine", endpoint: "https://mine.example.com/v1/systemone", apiKey: "k", enabled: true, models: [] }))
      .rejects.toMatchObject({ code: "org_policy_disallowed" });
    const ocr = new OcrManager(join(root, "ocr"), async () => (await appliedOrgPolicy(config, "ai.ocr.allowCustom"))?.value !== false);
    await expect(ocr.saveServer({ label: "Mine", endpoint: "https://mine.example.com/ocr", model: "m", languages: null, apiKey: "k" }))
      .rejects.toMatchObject({ code: "org_policy_disallowed" });
  });

  test("connectors: the member's own leave the engine, LegalWork's stay, and Firm Hub installs are refused", async () => {
    const { config } = await setup(entries);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ mcp: { mine: { type: "remote", url: "https://mine.example.com" }, "legalwork-ui": { type: "local", command: ["npx"] } } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect(Object.keys((await readJson(legalworkRuntimeConfigFilePath(config))).mcp ?? {})).toEqual(["legalwork-ui"]);
    await expect(requireHubInstallAllowed(config, "mcp")).rejects.toMatchObject({ code: "org_policy_disallowed" });
    await requireHubInstallAllowed(config, "skill");
  });
});

describe("the firm's workspace settings", () => {
  test("firm instructions follow the agent's, a switched-off extension leaves the engine, and review defaults apply", async () => {
    const { config, root } = await setup({
      "personalization.firmInstructions": { mode: "enforced", value: "Cite German law with paragraph numbers." },
      "extensions.builtIn": { mode: "enforced", value: { "computer-use": false } },
      "reviews.defaults": { mode: "enforced", value: { mode: "llm", minDecisionProbability: 0.9 } },
    });
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ mcp: { "computer-use": { type: "local", command: ["npx"] }, "legalwork-ui": { type: "local", command: ["npx"] } } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const runtime = await readJson(legalworkRuntimeConfigFilePath(config));
    expect(JSON.stringify(runtime.agent)).toContain("## Firm instructions");
    expect(JSON.stringify(runtime.agent)).toContain("Cite German law with paragraph numbers.");
    expect(Object.keys(runtime.mcp ?? {})).toEqual(["legalwork-ui"]);
    await expect(requireConnectorAllowed(config, "computer-use")).rejects.toMatchObject({ code: "org_policy_disallowed" });

    const defaults = new ReviewDefaults(root, {
      settings: async () => (await appliedOrgPolicy(config, "reviews.defaults"))?.value ?? null,
      requireUnmanaged: () => requireOrgPolicyUnmanaged(config, "reviews.defaults"),
    });
    expect(await defaults.settings({ mode: "jev", jev: null, llm: null })).toEqual({ mode: "llm", jev: null, llm: null, minDecisionProbability: 0.9 });
    await expect(defaults.saveSettings({ mode: "jev", jev: null, llm: null })).rejects.toMatchObject({ code: "org_policy_managed" });
  });
});
