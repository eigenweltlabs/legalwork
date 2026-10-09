import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { readSystemOneSettings, saveSystemOneMemberKey, saveSystemOneProvider, selectSystemOneProvider } from "./systemone.js";
import { requireConnectorAllowed, requireHubInstallAllowed } from "./org-policy-items.js";
import { ReviewDefaults } from "./reviews/storage.js";
import { AgentSandboxService } from "./agent-sandbox/service.js";
import { ApprovalService } from "./approvals.js";

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
  const previousData = process.env.XDG_DATA_HOME;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite");
  // The engine's keys and sign-ins (auth.json) of this test only.
  process.env.XDG_DATA_HOME = join(root, "data");
  const config = {
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
  } as unknown as ServerConfig;
  cleanups.push(async () => {
    resetOrgPolicyRuntimeForTests(config);
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
    else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
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
  test("the firm layer cannot restore host bash in a protected engine", async () => {
    const { config } = await setup({ "tools.permissions": { mode: "enforced", value: { bash: "allow", edit: "ask" } } });
    config.agentSandboxEnabled = true;
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    for (const path of [legalworkRuntimeConfigFilePath(config), join(orgPolicyEngineDir(config), "opencode.json")]) {
      const layer = await readJson(path);
      expect(layer.permission).toMatchObject({ bash: "deny", legalwork_shell: "allow", edit: "ask" });
      expect(layer.agent).toMatchObject({
        legalwork: { permission: { bash: "deny" } },
        build: { permission: { bash: "deny" } },
        plan: { permission: { bash: "deny" } },
      });
    }
  });

  test("protected commands enforce firm rules before launch even with stale agent permissions", async () => {
    const entries = { "tools.permissions": { mode: "enforced", value: { bash: "ask", edit: "deny" } } };
    const { config, root } = await setup(entries);
    config.workspaces[0].path = join(root, "matter");
    await mkdir(config.workspaces[0].path);
    config.authorizedRoots = [config.workspaces[0].path];
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { bash: "allow", read: "allow", edit: "allow" } }));
    const prompts: string[] = [];
    let executions = 0;
    const service = new AgentSandboxService(config, new ApprovalService({ mode: "auto", timeoutMs: 1000 }, async (request) => {
      prompts.push(request.action); return "allow";
    }), {
      status: async () => ({ available: true }), prepare: async () => "fixture",
      run: async () => { executions++; return { output: "done", exitCode: 0, truncated: false }; },
    });
    const run = (write: boolean) => service.run(config.workspaces[0], { command: "python report.py", write, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal,
      [{ permission: "*", pattern: "*", action: "allow" }]);
    await expect(run(true)).rejects.toThrow("edit is blocked");
    expect(executions).toBe(0);
    expect(prompts).toEqual(["sandbox.bash"]);
    await run(false);
    expect(executions).toBe(1);
    expect(prompts).toEqual(["sandbox.bash", "sandbox.bash"]);
    entries["tools.permissions"].value.bash = "deny";
    await scheduleOrgPolicySync(config, { force: true });
    await expect(run(false)).rejects.toThrow("bash is blocked");
    expect(executions).toBe(1);
  });

  test("a changed firm policy cancels an already running protected command", async () => {
    const entries = { "tools.permissions": { mode: "enforced", value: { bash: "allow" } } };
    const { config, root } = await setup(entries);
    config.workspaces[0].path = join(root, "matter");
    await mkdir(config.workspaces[0].path);
    config.authorizedRoots = [config.workspaces[0].path];
    const service = new AgentSandboxService(config, new ApprovalService({ mode: "auto", timeoutMs: 1000 }), {
      status: async () => ({ available: true }), prepare: async () => "fixture",
      run: async (input) => {
        entries["tools.permissions"].value.bash = "deny";
        await scheduleOrgPolicySync(config, { force: true });
        expect(input.signal.aborted).toBe(true);
        input.signal.throwIfAborted();
        return { output: "done", exitCode: 0, truncated: false };
      },
    });
    await expect(service.run(config.workspaces[0], { command: "sleep 100", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal))
      .rejects.toThrow("Organization policy changed");
  });

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
    const ocr = new OcrManager(join(root, "ocr"), () => orgOcr(config));
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

describe("the firm's own providers", () => {
  const entries = {
    "ai.chat.allowCustom": { mode: "enforced", value: false },
    "ai.chat.providers": {
      mode: "enforced",
      value: [
        { id: "org-anthropic-1", name: "Kanzlei Claude", source: { type: "catalog", provider: "anthropic" }, models: ["claude-sonnet-4-5"], key: { by: "firm", secretRef: "chat:org-anthropic-1" } },
        { id: "org-openai-1", name: "OpenAI", source: { type: "catalog", provider: "openai" }, models: "all", key: { by: "oauth" } },
        { id: "org-azure-1", name: "Kanzlei Azure", source: { type: "custom", baseURL: "https://azure.example.com/v1", apiType: "responses" }, models: ["gpt-5"], key: { by: "member" } },
      ],
    },
    "ai.systemOne.providers": {
      mode: "enforced",
      value: [{ id: "org-jev-1", name: "Kanzlei JEV", endpoint: "https://jev.example.com/v1/systemone", models: [{ id: "jev-1", name: "JEV 1", questionTypes: ["noul"] }], key: { by: "member" } }],
    },
    "ai.systemOne.model": { mode: "default", value: { providerId: "org-jev-1", model: "jev-1" } },
    "ai.ocr.engines": {
      mode: "enforced",
      value: [{ id: "org-ocr-1", label: "Kanzlei OCR", kind: "mistral-ocr", model: "mistral-ocr-latest", endpoint: "https://ocr.example.com/v1/ocr", key: { by: "member" } }],
    },
    "ai.ocr.defaultEngine": { mode: "enforced", value: "org-ocr-1" },
  };

  test("chat providers reach the engine with a key: the firm's while signed in, or the member's own", async () => {
    const { config, root } = await setup(entries, { "chat:org-anthropic-1": "sk-firm" });
    // The member added their own key for the firm's Azure endpoint; OpenAI waits for their ChatGPT sign-in.
    await mkdir(join(root, "data", "opencode"), { recursive: true });
    await writeFile(join(root, "data", "opencode", "auth.json"), JSON.stringify({ "org-azure-1": { type: "api", key: "sk-mine" } }));
    // A member's disconnect does not switch the firm's provider off.
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ disabled_providers: ["anthropic", "groq"] }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).disabled_providers).toEqual(["groq", "opencode"]);
    const layer = await readJson(join(orgPolicyEngineDir(config), "opencode.json"));
    expect(layer.enabled_providers).toEqual(["eigenwelt", "anthropic", "openai", "org-azure-1"]);
    expect(layer.provider).toEqual({
      anthropic: { name: "Kanzlei Claude", options: { apiKey: "sk-firm" }, whitelist: ["claude-sonnet-4-5"] },
      "org-azure-1": {
        npm: "@ai-sdk/openai",
        name: "Kanzlei Azure",
        options: { baseURL: "https://azure.example.com/v1" },
        models: { "gpt-5": { name: "gpt-5", tool_call: true } },
      },
    });

    // Signed out: the firm's key goes, and with it the provider; the member's own key stays.
    await writeEigenweltConnection(config, { platformToken: null, account: null, platformURL: null });
    await scheduleOrgPolicySync(config, { force: true });
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const provider = (await readJson(join(orgPolicyEngineDir(config), "opencode.json"))).provider;
    expect(Object.keys(provider ?? {})).toEqual(["org-azure-1"]);
    expect(JSON.stringify(provider)).not.toContain("sk-firm");
  });

  test("SystemOne lists the firm's provider until the member adds their key, and the firm's default model applies", async () => {
    const { config } = await setup(entries);
    fakeFetch(() => new Response(null, { status: 503 }));
    let settings = await readSystemOneSettings(config);
    expect(settings.selection).toEqual({ providerId: "org-jev-1", model: "jev-1" });
    expect(settings.providers.find((provider) => provider.id === "org-jev-1")).toMatchObject({ managed: true, firmKey: "member", status: "disconnected" });
    await saveSystemOneMemberKey(config, "org-jev-1", "sk-mine");
    settings = await readSystemOneSettings(config);
    expect(settings.providers.find((provider) => provider.id === "org-jev-1")?.status).not.toBe("disconnected");
    // The member changes it only after taking the firm's default back (the app asks first).
    await expect(selectSystemOneProvider(config, { providerId: "eigenwelt", model: "EigenJev" })).rejects.toMatchObject({ code: "org_policy_managed" });
  });

  test("OCR adds the firm's engine as the default, waiting for the member's key", async () => {
    const { config, root } = await setup(entries);
    const ocr = new OcrManager(join(root, "ocr"), () => orgOcr(config));
    let view = await ocr.view();
    expect(view.defaultEngineId).toBe("org-ocr-1");
    expect(view.engines.find((engine) => engine.id === "org-ocr-1")).toMatchObject({ firmKey: "member", keyConfigured: false, status: "missing-key" });
    await ocr.setMemberKey("org-ocr-1", "sk-mine");
    view = await ocr.view();
    expect(view.engines.find((engine) => engine.id === "org-ocr-1")).toMatchObject({ keyConfigured: true, status: "ready" });
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
