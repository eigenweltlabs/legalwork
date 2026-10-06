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
import { orgOcr } from "./org-policy-ai.js";
import { readSystemOneSettings, saveSystemOneProvider, selectSystemOneProvider } from "./systemone.js";
import { orgPolicyItemsLayer, orgPolicyPlugins, requireConnectorAllowed, requireHubInstallAllowed, syncOrgPolicyItems } from "./org-policy-items.js";
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

async function setup(entries: Record<string, unknown>, secrets: Record<string, string> = {}) {
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
      : url.endsWith("/api/desktop/policy/secrets")
        ? Response.json({ schemaVersion: 1, revision: 1, secrets })
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

  test("defaults replace the member's rule, and nothing is enforced once taken back", async () => {
    const { config } = await setup({ "tools.permissions": { mode: "default", value: { webfetch: "deny" } } });
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { webfetch: "allow" } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).permission).toMatchObject({ webfetch: "deny" });
    expect(await readJson(join(orgPolicyEngineDir(config), "opencode.json"))).toEqual({ $schema: "https://opencode.ai/config.json" });

    await releaseOrgPolicyKey(config, "tools.permissions");
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).permission).toMatchObject({ webfetch: "allow" });
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

describe("the firm's AI providers", () => {
  const entries = {
    "ai.chat.allowCustom": { mode: "enforced", value: false },
    "ai.systemOne.allowCustom": { mode: "enforced", value: false },
    "ai.ocr.allowCustom": { mode: "enforced", value: false },
    "ai.chat.providers": {
      mode: "enforced",
      value: [{ id: "org-azure", name: "Kanzlei Azure", baseURL: "https://azure.example.com/v1", apiType: "responses", models: [{ id: "gpt-5", contextLimit: 200000 }], secretRef: "chat:org-azure" }],
    },
    "ai.systemOne.providers": {
      mode: "enforced",
      value: [{ id: "org-jev", name: "Kanzlei JEV", endpoint: "https://jev.example.com/v1/systemone", models: [{ id: "jev-1", name: "JEV 1", questionTypes: ["noul"] }], secretRef: "systemone:org-jev" }],
    },
    "ai.systemOne.model": { mode: "enforced", value: { providerId: "org-jev", model: "jev-1" } },
    "ai.ocr.engines": {
      mode: "enforced",
      value: [{ id: "org-ocr", label: "Kanzlei OCR", kind: "mistral-ocr", model: "mistral-ocr-latest", endpoint: "https://ocr.example.com/v1/ocr", secretRef: "ocr:org-ocr" }],
    },
    "ai.ocr.defaultEngine": { mode: "enforced", value: "org-ocr" },
  };
  const secrets = { "chat:org-azure": "sk-chat", "systemone:org-jev": "sk-jev", "ocr:org-ocr": "sk-ocr" };

  test("chat providers reach the engine with their key while signed in, and only the firm's are enabled", async () => {
    const { config } = await setup(entries, secrets);
    // A member's disconnect does not switch the firm's provider off.
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ disabled_providers: ["org-azure", "openai"] }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).disabled_providers).toEqual(["openai", "opencode"]);
    const layer = await readJson(join(orgPolicyEngineDir(config), "opencode.json"));
    expect(layer.enabled_providers).toEqual(["eigenwelt", "org-azure"]);
    expect(layer.provider).toMatchObject({
      "org-azure": { npm: "@ai-sdk/openai", name: "Kanzlei Azure", options: { baseURL: "https://azure.example.com/v1", apiKey: "sk-chat" } },
    });

    await writeEigenweltConnection(config, { platformToken: null, account: null, platformURL: null });
    await scheduleOrgPolicySync(config, { force: true });
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(join(orgPolicyEngineDir(config), "opencode.json"))).provider).toBeUndefined();
  });

  test("SystemOne lists the firm's provider and model, and refuses own providers", async () => {
    const { config } = await setup(entries, secrets);
    fakeFetch(() => new Response(null, { status: 503 }));
    const settings = await readSystemOneSettings(config);
    expect(settings.selection).toEqual({ providerId: "org-jev", model: "jev-1" });
    expect(settings.providers.find((provider) => provider.id === "org-jev")).toMatchObject({ managed: true, name: "Kanzlei JEV" });
    await expect(saveSystemOneProvider(config, { id: "mine", name: "Mine", endpoint: "https://mine.example.com/v1/systemone", apiKey: "k", enabled: true, models: [] }))
      .rejects.toMatchObject({ code: "org_policy_disallowed" });
    await expect(selectSystemOneProvider(config, { providerId: "eigenwelt", model: "EigenJev" })).rejects.toMatchObject({ code: "org_policy_managed" });
  });

  test("OCR adds the firm's engine as the default and refuses own servers", async () => {
    const { config, root } = await setup(entries, secrets);
    const ocr = new OcrManager(join(root, "ocr"), () => orgOcr(config));
    const view = await ocr.view();
    expect(view.defaultEngineId).toBe("org-ocr");
    expect(view.engines.find((engine) => engine.id === "org-ocr")).toMatchObject({ managed: true, keyConfigured: true, status: "ready" });
    await expect(ocr.saveServer({ label: "Mine", endpoint: "https://mine.example.com/ocr", model: "m", languages: null, apiKey: "k" }))
      .rejects.toMatchObject({ code: "org_policy_disallowed" });
  });
});

describe("the firm's Firm Hub items", () => {
  test("connectors, skills and plugins arrive in the firm's folder, follow the policy and keep credentials in memory", async () => {
    const entries: Record<string, unknown> = {
      "connectors.managed": { mode: "enforced", value: ["hub-crm"] },
      "skills.managed": { mode: "enforced", value: ["hub-dd"] },
      "plugins.managed": { mode: "enforced", value: ["hub-plugin"] },
      "connectors.allowCustom": { mode: "enforced", value: false },
    };
    const { config } = await setup(entries);
    const hub: Record<string, unknown> = {
      "hub-crm": { id: "hub-crm", kind: "mcp", name: "crm", version: 1, hasSecret: true, canAccessSecret: true, payload: { key: "crm", mcp: { type: "remote", url: "https://crm.example.com/mcp" } } },
      "hub-dd": { id: "hub-dd", kind: "workflow", name: "due-diligence-firm", version: 2, payload: { files: [{ path: "SKILL.md", contentBase64: Buffer.from("---\nname: due-diligence-firm\ndescription: DD\n---\nSteps").toString("base64") }] } },
      "hub-plugin": { id: "hub-plugin", kind: "plugin", name: "firm-plugin", version: 1, pinned: true, payload: { spec: "firm-plugin@1.0.0" } },
    };
    const policy = () => Response.json({ schemaVersion: 1, orgId: "org_kanzlei", orgName: "Kanzlei", revision: 1, role: "member", updatedAt: null, entries });
    fakeFetch((url) => {
      if (url.endsWith("/api/desktop/policy")) return policy();
      if (url.endsWith("/api/hub/hub-crm/secret")) return Response.json({ secret: JSON.stringify({ type: "remote", url: "https://crm.example.com/mcp", headers: { Authorization: "Bearer firm" } }) });
      const id = url.split("/api/hub/")[1];
      return id && hub[id] ? Response.json(hub[id]) : new Response(null, { status: 404 });
    });
    const dir = orgPolicyEngineDir(config);
    expect(await syncOrgPolicyItems(config, dir)).toBe(true);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ mcp: { mine: { type: "remote", url: "https://mine.example.com" }, "legalwork-ui": { type: "local", command: ["npx"] } } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");

    const layer = await readJson(join(dir, "opencode.json"));
    expect(layer.mcp).toEqual({ crm: { type: "remote", url: "https://crm.example.com/mcp", headers: { Authorization: "Bearer firm" } } });
    expect(layer.plugin).toEqual(["firm-plugin@1.0.0"]);
    expect(await orgPolicyPlugins(dir)).toEqual([{ spec: "firm-plugin@1.0.0", source: "org", scope: "global" }]);
    expect(await readFile(join(dir, "skills", "due-diligence-firm", "SKILL.md"), "utf8")).toContain("Steps");
    // The member's own connector is left out; LegalWork's own stays.
    expect(Object.keys((await readJson(legalworkRuntimeConfigFilePath(config))).mcp ?? {})).toEqual(["legalwork-ui"]);
    await expect(requireHubInstallAllowed(config, "mcp")).rejects.toMatchObject({ code: "org_policy_disallowed" });
    await requireHubInstallAllowed(config, "skill");

    // Signed out: the connector stays, its credentials go.
    await writeEigenweltConnection(config, { platformToken: null, account: null, platformURL: null });
    await scheduleOrgPolicySync(config, { force: true });
    expect(await syncOrgPolicyItems(config, dir)).toBe(true);
    expect((await orgPolicyItemsLayer(config, dir)).mcp).toEqual({ crm: { type: "remote", url: "https://crm.example.com/mcp" } });

    // Taken back: the firm's items leave.
    await releaseOrgPolicyKey(config, "skills.managed");
    await syncOrgPolicyItems(config, dir);
    expect(await readFile(join(dir, "skills", "due-diligence-firm", "SKILL.md"), "utf8").catch(() => null)).toBeNull();
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
