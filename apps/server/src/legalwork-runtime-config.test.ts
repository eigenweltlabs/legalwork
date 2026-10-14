import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { writeCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import {
  keepLegalworkRuntimeConfigFileFresh,
  legalworkRuntimeConfigFilePath,
  writeLegalworkRuntimeConfigFile,
} from "./legalwork-runtime-config.js";
import {
  GLOBAL_PERSONALIZATION_ID,
  GLOBAL_TOOL_PERMISSIONS_ID,
  readRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousDb;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-runtime-config-file-"));
  roots.push(root);
  previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, config };
}

async function readConfigFile(config: ServerConfig): Promise<Record<string, unknown>> {
  const raw = await readFile(legalworkRuntimeConfigFilePath(config), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("legalwork runtime config file", () => {
  test("a cold channel worker gains its managed model after boot and refreshes a rotated key", async () => {
    const { root, config } = await setup();
    const previousSelection = process.env.LEGALWORK_CHANNEL_MODEL;
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.LEGALWORK_CHANNEL_MODEL = join(root, "channel-model.json");
    process.env.XDG_CONFIG_HOME = join(root, "config");
    try {
      await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current,
        agent: { reviewer: { mode: "subagent" } },
      }));
      await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, current => ({ ...current, permission: { bash: "ask" } }));
      await writeLegalworkRuntimeConfigFile(config, "ws_1");
      expect((await readConfigFile(config)).provider).toEqual({});

      await mkdir(join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
      await writeFile(process.env.LEGALWORK_CHANNEL_MODEL, JSON.stringify({ providerID: "eigenwelt-cloud", modelID: "test-model" }));
      const file = join(process.env.XDG_CONFIG_HOME, "opencode/opencode.json");
      const provider = (apiKey: string) => ({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://model.example/v1", apiKey }, models: { "test-model": { name: "Test" } } });
      await writeFile(file, JSON.stringify({ model: "unrelated/default", permission: { bash: "allow" }, provider: { "eigenwelt-cloud": provider("scoped-first"), unrelated: provider("private-other") } }));
      await writeLegalworkRuntimeConfigFile(config, "ws_1");
      const before = z.object({ provider: z.record(z.string(), z.object({ options: z.object({ apiKey: z.string() }) })), permission: z.object({ bash: z.string() }), agent: z.record(z.string(), z.unknown()) }).parse(await readConfigFile(config));
      expect(Object.keys(before.provider)).toEqual(["eigenwelt-cloud"]);
      expect(before.provider["eigenwelt-cloud"].options.apiKey).toBe("scoped-first");
      expect(before.permission.bash).toBe("ask");
      expect(before.agent.reviewer).toEqual({ mode: "subagent" });

      await writeFile(file, JSON.stringify({ provider: { "eigenwelt-cloud": provider("scoped-rotated") } }));
      await writeLegalworkRuntimeConfigFile(config, "ws_1");
      const after = z.object({ provider: z.record(z.string(), z.object({ options: z.object({ apiKey: z.string() }) })) }).parse(await readConfigFile(config));
      expect(after.provider["eigenwelt-cloud"].options.apiKey).toBe("scoped-rotated");
      expect((await readRuntimeOpencodeConfig(config, "ws_1")).provider).toBeUndefined();
      expect((await readConfigFile(config)).model).toBeUndefined();
    } finally {
      if (previousSelection === undefined) delete process.env.LEGALWORK_CHANNEL_MODEL;
      else process.env.LEGALWORK_CHANNEL_MODEL = previousSelection;
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });

  test("writes runtime-DB MCPs and legalwork defaults into the file", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
      agent: { reviewer: { mode: "subagent", model: "opencode/big-pickle" } },
    }));

    const path = await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect(path).toBe(legalworkRuntimeConfigFilePath(config));

    const parsed = await readConfigFile(config);
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.posthog?.enabled).toBe(true);
    expect(parsed.default_agent).toBe("legalwork");
    expect(Array.isArray(parsed.plugin)).toBe(true);
    expect(JSON.stringify(parsed.plugin)).not.toContain("legalwork-document-tools");
    // The Anthropic auth plugin must be wired so "Sign in with Anthropic"
    // (Claude Pro/Max + Console API-key OAuth) methods are offered by the engine.
    expect(parsed.plugin as string[]).toContain("opencode-anthropic-auth");
    // No server-injected provider blocks: the engine treats any config-defined
    // provider as always-connected, so the eigenwelt provider only exists when
    // written into the per-workspace runtime config at connect time.
    expect((parsed.provider as Record<string, unknown> | undefined)?.eigenwelt).toBeUndefined();
    const agents = parsed.agent as Record<string, Record<string, unknown>>;
    expect(agents["legalwork-scheduled-project"]).toMatchObject({ hidden: true, mode: "primary", permission: { "*": "deny", legalwork_project_read: "allow" } });
    expect(agents["legalwork-scheduled-all"]).toMatchObject({ hidden: true, mode: "primary", permission: { legalwork_ui_execute_action: "deny", legalwork_ui_list_actions: "deny", legalwork_ui_snapshot: "deny" } });
    expect(JSON.stringify(parsed.plugin)).toContain("legalwork-scheduled-task-tools");
    expect(agents.legalwork.prompt).toContain("start-tabular-review");
    expect(agents.legalwork.prompt).toContain("at most one short sentence");
    expect(agents.reviewer?.model).toBe("opencode/big-pickle");
  });

  test("bundled plugin specs are file:// URLs so import() works on Windows", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");

    const parsed = await readConfigFile(config);
    const plugins = parsed.plugin as string[];
    const localPlugins = plugins.filter((spec) => /legalwork-[a-z-]+\.(?:js|ts)\?v=/.test(spec));
    // Every bundled plugin resolves to a file on disk, so each must be a
    // file:// URL. A bare absolute path (esp. a Windows `C:\…` path) makes
    // OpenCode's dynamic import() throw ERR_UNSUPPORTED_ESM_URL_SCHEME and
    // fails the whole config load — no providers, no tasks.
    expect(localPlugins.some((spec) => /legalwork-storage-tools\.(?:js|ts)\?v=/.test(spec))).toBe(true);
    expect(localPlugins.length).toBeGreaterThan(0);
    for (const spec of localPlugins) {
      expect(spec.startsWith("file://")).toBe(true);
      expect(new URL(spec).searchParams.get("v")).toMatch(/^\d+(\.\d+)?-\d+$/);
    }
  });

  test("keepLegalworkRuntimeConfigFileFresh rewrites the file on runtime-DB writes", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    cleanups.push(keepLegalworkRuntimeConfigFileFresh(config, "ws_1"));

    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { stripe: { type: "remote", url: "https://mcp.stripe.com", enabled: false } },
    }));

    // The refresh is fire-and-forget; poll briefly for the rewrite.
    let mcp: Record<string, Record<string, unknown>> = {};
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const parsed = await readConfigFile(config);
      mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
      if (mcp.stripe) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mcp.stripe?.enabled).toBe(false);
  });

  test("writes for other workspaces do not rewrite the primary file", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    cleanups.push(keepLegalworkRuntimeConfigFileFresh(config, "ws_1"));

    await writeRuntimeOpencodeConfig(config, "ws_other", (current) => ({
      ...current,
      mcp: { other: { type: "remote", url: "https://example.com/mcp", enabled: true } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.other).toBeUndefined();
  });

  test("global tool permissions land in every workspace's file and rewrite it on change", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      permission: { external_directory: { "/tmp/shared/*": "allow" } },
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    cleanups.push(keepLegalworkRuntimeConfigFileFresh(config, "ws_1"));

    // A write to the reserved global row must rebuild this workspace's file.
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, (current) => ({
      ...current,
      permission: { bash: "ask" },
    }));

    let permission: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const parsed = await readConfigFile(config);
      permission = (parsed.permission ?? {}) as Record<string, unknown>;
      if (permission.bash) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Global tool key + this workspace's own external_directory, merged.
    expect(permission.bash).toBe("ask");
    expect(permission.external_directory).toEqual({ "/tmp/shared/*": "allow" });
  });

  test("global personalisation rewrites the active workspace config", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    cleanups.push(keepLegalworkRuntimeConfigFileFresh(config, "ws_1"));

    // Saved while local memories existed: the flags stay in the stored JSON.
    const saved: { customInstructions: string; localMemoriesEnabled: boolean; allowToolAssistedMemory: boolean; personality: "professional" } = {
      customInstructions: "Use concise issue-rule-analysis conclusions.",
      localMemoriesEnabled: true,
      allowToolAssistedMemory: false,
      personality: "professional",
    };
    await writeRuntimeOpencodeConfig(config, GLOBAL_PERSONALIZATION_ID, (current) => ({
      ...current,
      personalization: saved,
    }));

    let prompt = "";
    let plugins: string[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const parsed = await readConfigFile(config);
      const agents = parsed.agent as Record<string, Record<string, unknown>>;
      prompt = typeof agents.legalwork?.prompt === "string" ? agents.legalwork.prompt : "";
      plugins = Array.isArray(parsed.plugin) ? parsed.plugin.filter((item) => typeof item === "string") : [];
      if (prompt.includes("issue-rule-analysis")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(prompt).toContain("Use concise issue-rule-analysis conclusions.");
    expect(prompt).not.toContain("Local memory policy");
    expect(plugins.some((plugin) => plugin.includes("agent-memory"))).toBe(false);
  });

  test("project instruction updates require approval even with broad tool allow rules", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, current => ({
      ...current,
      permission: { legalwork_project_set_instructions: "allow", "*": "allow", bash: "ask" },
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = await readConfigFile(config);
    if (typeof parsed.permission !== "object" || parsed.permission === null) throw new Error("Permission config missing");
    expect(parsed.permission).toMatchObject({ "*": "allow", bash: "ask", legalwork_project_set_instructions: "ask" });
    expect(Object.keys(parsed.permission).at(-1)).toBe("legalwork_project_set_instructions");
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, current => ({
      ...current, permission: { legalwork_project_set_instructions: "deny" },
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readConfigFile(config)).permission).toMatchObject({ legalwork_project_set_instructions: "deny" });
  });
});

describe("eigenwelt free provider injection", () => {
  // The cached manifest now carries this DEVICE's own key (minted once via
  // /api/public/free-key) — limits are per-key on the gateway.
  const FREE_MANIFEST = {
    baseURL: "https://free.gateway.test/v1",
    apiKey: "sk-device-key-1",
    models: [
      { id: "ewl-free-small", name: "EWL Free Small", contextLength: 32000 },
      { id: "ewl-free-base" },
    ],
  };

  type FreeProviderBlock = {
    npm?: string;
    name?: string;
    options?: { baseURL?: string; apiKey?: string; headers?: Record<string, string> };
    models?: Record<string, { name?: string; tool_call?: boolean; reasoning?: boolean; limit?: { context?: number; output?: number } }>;
  };

  test("free tier retired: zen is always disabled, no eigenwelt-free block", async () => {
    const { config } = await setup();
    // The user's runtime DB may disable other providers — preserved, deduped.
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      disabled_providers: ["openrouter", "opencode"],
    }));

    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = await readConfigFile(config);

    expect((parsed.provider as Record<string, unknown> | undefined)?.["eigenwelt-free"]).toBeUndefined();
    const disabled = parsed.disabled_providers as string[];
    expect(disabled).toContain("opencode");
    expect(disabled).toContain("openrouter");
    expect(disabled.filter((id) => id === "opencode")).toHaveLength(1);
  });

  test("zen stays disabled even with an empty runtime DB", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = await readConfigFile(config);
    expect((parsed.provider as Record<string, unknown> | undefined)?.["eigenwelt-free"]).toBeUndefined();
    expect(((parsed.disabled_providers ?? []) as string[])).toContain("opencode");
  });

  test("runtime-DB providers survive the config build unclobbered", async () => {
    const { config } = await setup();
    // Paid eigenwelt provider (connect flow) lives in the runtime DB.
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      provider: {
        eigenwelt: {
          npm: "@ai-sdk/openai-compatible",
          name: "Eigenwelt Subscription",
          options: { baseURL: "https://paid.gateway.test/v1" },
          models: { "ewl-pro": { name: "EWL Pro", limit: { context: 200000, output: 16384 } } },
        },
      },
    }));

    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = await readConfigFile(config);
    const providers = parsed.provider as Record<string, FreeProviderBlock>;
    expect(providers.eigenwelt?.name).toBe("Eigenwelt Subscription");
  });
});

describe("eigenwelt paid provider injection", () => {
  test("serves every workspace, whichever one the firm signed in from", async () => {
    const { config } = await setup();
    await writeCachedEigenweltPaidManifest(config, {
      baseURL: "https://paid.gateway.test/v1",
      apiKey: "sk-firm-key",
      models: [{ id: "Eigenwelt Europe" }],
    });
    // Signed in while ws_1 was open; the file is then built for another
    // workspace (switching makes it the primary one). The models must stay.
    await writeEigenweltConnection(config, {
      platformToken: "access",
      entitlements: parseEigenweltEntitlements({ plan: "plus", features: ["premium_models"] }) ?? null,
    });

    await writeLegalworkRuntimeConfigFile(config, "ws_other");
    const providers = (await readConfigFile(config)).provider as Record<string, { models?: Record<string, unknown> }>;
    expect(Object.keys(providers.eigenwelt?.models ?? {})).toEqual(["Eigenwelt Europe"]);
  });
});

test.each([false, true])("an empty Sync manifest removes stale workspace models (BYO connected: %s)", async (byo) => {
  const { config } = await setup();
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://paid.gateway.test/v1", apiKey: "paid-key", models: [] });
  await writeEigenweltConnection(config, { platformToken: "access",
    entitlements: parseEigenweltEntitlements({ plan: "sync", features: ["premium_models"] }) ?? null });
  await writeRuntimeOpencodeConfig(config, "ws_1", current => ({ ...current, provider: {
    eigenwelt: { npm: "@ai-sdk/openai-compatible", models: { "Eigenwelt Europe": { name: "Old model" } } },
    ...(byo ? { openai: { models: { "gpt-test": { name: "My OpenAI model" } } } } : {}),
  } }));
  await writeLegalworkRuntimeConfigFile(config, "ws_1");
  const providers = (await readConfigFile(config)).provider;
  if (byo) expect(providers).toMatchObject({ openai: { models: { "gpt-test": { name: "My OpenAI model" } } } });
  else expect(providers).toEqual({});
  expect(providers).not.toHaveProperty("eigenwelt");
});
