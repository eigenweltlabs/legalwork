import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  keepLegalworkRuntimeConfigFileFresh,
  legalworkRuntimeConfigFilePath,
  writeLegalworkRuntimeConfigFile,
} from "./legalwork-runtime-config.js";
import { eigenweltFreeManifestCachePath } from "./eigenwelt-free.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
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
    // The Anthropic auth plugin must be wired so "Sign in with Anthropic"
    // (Claude Pro/Max + Console API-key OAuth) methods are offered by the engine.
    expect(parsed.plugin as string[]).toContain("opencode-anthropic-auth");
    // No server-injected provider blocks: the engine treats any config-defined
    // provider as always-connected, so the eigenwelt provider only exists when
    // written into the per-workspace runtime config at connect time.
    expect((parsed.provider as Record<string, unknown> | undefined)?.eigenwelt).toBeUndefined();
    const agents = parsed.agent as Record<string, Record<string, unknown>>;
    expect(agents.reviewer?.model).toBe("opencode/big-pickle");
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

  test("seeded disk cache: injects eigenwelt-free (both limit keys, per-device apiKey, no device header) and disables zen", async () => {
    const { config } = await setup();
    await writeFile(eigenweltFreeManifestCachePath(config), JSON.stringify(FREE_MANIFEST), "utf8");
    // The user's runtime DB may disable other providers — preserved, deduped.
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      disabled_providers: ["openrouter", "opencode"],
    }));

    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = await readConfigFile(config);

    const free = (parsed.provider as Record<string, FreeProviderBlock>)[
      "eigenwelt-free"
    ];
    expect(free).toBeDefined();
    expect(free.npm).toBe("@ai-sdk/openai-compatible");
    expect(free.name).toBe("Eigenwelt Free");
    // This device's own key inline in options — intentional for the free tier.
    expect(free.options?.baseURL).toBe("https://free.gateway.test/v1");
    expect(free.options?.headers?.Authorization).toBe("Bearer sk-device-key-1");
    // Limits are keyed on the virtual key itself now; the old
    // x-litellm-end-user-id header must NOT be injected anymore.
    expect(free.options?.apiKey).toBeUndefined();
    // BOTH limit keys are mandatory: one missing key silently invalidates
    // the whole runtime config in the engine schema and kills all plugins.
    expect(free.models?.["ewl-free-small"]?.limit).toEqual({ context: 32000, output: 16384 });
    expect(free.models?.["ewl-free-base"]?.limit).toEqual({ context: 128000, output: 16384 });
    expect(free.models?.["ewl-free-small"]?.tool_call).toBe(true);
    expect(free.models?.["ewl-free-small"]?.reasoning).toBe(false);

    const disabled = parsed.disabled_providers as string[];
    expect(disabled).toContain("opencode");
    expect(disabled).toContain("openrouter");
    expect(disabled.filter((id) => id === "opencode")).toHaveLength(1);

    // The cached device key is stable across config rebuilds.
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const rebuilt = await readConfigFile(config);
    const rebuiltFree = (rebuilt.provider as Record<string, FreeProviderBlock>)["eigenwelt-free"];
    expect(rebuiltFree.options?.headers?.Authorization).toBe("Bearer sk-device-key-1");
  });

  test("no disk cache: no eigenwelt-free block and zen stays enabled", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = await readConfigFile(config);
    expect((parsed.provider as Record<string, unknown> | undefined)?.["eigenwelt-free"]).toBeUndefined();
    // Zen must NOT be disabled when the free provider is unavailable —
    // otherwise a first launch with the platform down loses free models.
    const disabled = (parsed.disabled_providers ?? []) as string[];
    expect(disabled).not.toContain("opencode");
  });

  test("corrupt disk cache is ignored; empty-model cache injects nothing", async () => {
    const { config } = await setup();
    await writeFile(eigenweltFreeManifestCachePath(config), "not json {", "utf8");
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    let parsed = await readConfigFile(config);
    expect((parsed.provider as Record<string, unknown> | undefined)?.["eigenwelt-free"]).toBeUndefined();
    expect(((parsed.disabled_providers ?? []) as string[])).not.toContain("opencode");

    // A valid manifest with zero models must not inject the provider either.
    await writeFile(
      eigenweltFreeManifestCachePath(config),
      JSON.stringify({ ...FREE_MANIFEST, models: [] }),
      "utf8",
    );
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    parsed = await readConfigFile(config);
    expect((parsed.provider as Record<string, unknown> | undefined)?.["eigenwelt-free"]).toBeUndefined();
    expect(((parsed.disabled_providers ?? []) as string[])).not.toContain("opencode");
  });

  test("free provider merges with runtime-DB providers without clobbering them", async () => {
    const { config } = await setup();
    await writeFile(eigenweltFreeManifestCachePath(config), JSON.stringify(FREE_MANIFEST), "utf8");
    // Paid eigenwelt provider (connect flow) lives in the runtime DB.
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      provider: {
        eigenwelt: {
          npm: "@ai-sdk/openai-compatible",
          name: "Eigenwelt Model API",
          options: { baseURL: "https://paid.gateway.test/v1" },
          models: { "ewl-pro": { name: "EWL Pro", limit: { context: 200000, output: 16384 } } },
        },
      },
    }));

    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    const parsed = await readConfigFile(config);
    const providers = parsed.provider as Record<string, FreeProviderBlock>;
    expect(providers.eigenwelt?.name).toBe("Eigenwelt Model API");
    expect(providers["eigenwelt-free"]?.name).toBe("Eigenwelt Free");
  });
});
