import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_MEMORY_PLUGIN_SPEC,
  buildPersonalizedAgentPrompt,
  deleteAllLocalMemories,
} from "./personalization.js";
import {
  GLOBAL_PERSONALIZATION_ID,
  readGlobalPersonalizationSettings,
  readRuntimeOpencodeConfig,
  type PersonalizationSettings,
} from "./runtime-opencode-config-store.js";
import { buildLegalworkRuntimeConfigObject } from "./legalwork-runtime-config.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousDb;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-personalization-"));
  roots.push(root);
  previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: "ws_1", name: "Test", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
  return { config, root, workspace };
}

async function missing(path: string) {
  await expect(stat(path)).rejects.toThrow();
}

describe("Personalisation", () => {
  test("appends personality, custom instructions, and the privacy-aware memory policy", () => {
    const prompt = buildPersonalizedAgentPrompt("Base prompt", {
      customInstructions: "Always use short headings.",
      localMemoriesEnabled: true,
      allowToolAssistedMemory: false,
      personality: "pragmatic",
    });
    expect(prompt).toContain("Base prompt");
    expect(prompt).toContain("Always use short headings.");
    expect(prompt).toContain("Use a pragmatic tone");
    expect(prompt).toContain("Do not create or update memory from web search");
  });

  test("persists host-wide settings and activates Agent Memory in the runtime config", async () => {
    const { config } = await setup();
    const server = await startServer(config);
    try {
      const settings: PersonalizationSettings = {
        customInstructions: "Use numbered recommendations.",
        localMemoriesEnabled: true,
        allowToolAssistedMemory: true,
        personality: "professional",
      };
      const put = await fetch(`http://127.0.0.1:${server.port}/personalization`, {
        method: "PUT",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ settings });

      const get = await fetch(`http://127.0.0.1:${server.port}/personalization`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      expect(get.status).toBe(200);
      expect(await get.json()).toEqual({ settings });
      expect(await readGlobalPersonalizationSettings(config)).toEqual(settings);
      expect((await readRuntimeOpencodeConfig(config, GLOBAL_PERSONALIZATION_ID)).personalization).toEqual(settings);

      const runtime = await buildLegalworkRuntimeConfigObject(config, "ws_1");
      expect(runtime.plugin).toContain(AGENT_MEMORY_PLUGIN_SPEC);
      const agents = runtime.agent as Record<string, Record<string, unknown>>;
      expect(agents.legalwork?.prompt).toContain("Use numbered recommendations.");
      expect(agents.legalwork?.prompt).toContain("Use a professional tone");
    } finally {
      await server.stop();
    }
  });

  test("deletes global and workspace memory blocks without touching their parent directories", async () => {
    const { config, root, workspace } = await setup();
    const globalMemory = join(root, "test-global-memory");
    const projectMemory = join(workspace, ".opencode", "memory");
    await mkdir(globalMemory, { recursive: true });
    await mkdir(projectMemory, { recursive: true });
    await writeFile(join(globalMemory, "human.md"), "private preference", "utf8");
    await writeFile(join(projectMemory, "project.md"), "private matter context", "utf8");

    expect(await deleteAllLocalMemories(config, globalMemory)).toBe(2);
    await missing(globalMemory);
    await missing(projectMemory);
    expect((await stat(workspace)).isDirectory()).toBe(true);
  });
});
