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
import { LegalWorkCapabilitiesKnowledge } from "./opencode-plugins/legalwork-capabilities-knowledge.js";
import { readLegalworkWorkspaceConfig, writeLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import { readProjectDetails, updateProjectDetails } from "./project-store.js";

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

  test("project prompts persist, stay isolated, and refresh existing chats on the next turn", async () => {
    const { config, root, workspace } = await setup();
    const nested = join(workspace, "nested");
    await mkdir(nested, { recursive: true });
    config.workspaces.push({ id: "ws_2", name: "Second project", path: nested, preset: "starter", workspaceType: "local" });
    await writeLegalworkWorkspaceConfig(config, "ws_1", () => ({ unrelated: "keep" }));
    const server = await startServer(config);
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
    const previousUrl = process.env.LEGALWORK_SERVER_URL;
    const previousToken = process.env.LEGALWORK_SERVER_TOKEN;
    process.env.LEGALWORK_SERVER_URL = base;
    process.env.LEGALWORK_SERVER_TOKEN = config.token;
    const write = async (id: string, customInstructions: string) => {
      const project = config.workspaces.find((item) => item.id === id);
      if (!project) throw new Error("Project missing");
      const { revision } = await readProjectDetails(project.path);
      return fetch(`${base}/workspace/${id}/personalization`, {
        method: "PUT", headers, body: JSON.stringify({ customInstructions, revision }),
      });
    };
    const firstPlugin = await LegalWorkCapabilitiesKnowledge({ directory: workspace });
    const secondPlugin = await LegalWorkCapabilitiesKnowledge({ directory: join(nested, "documents") });
    const prompt = async (plugin: typeof firstPlugin) => {
      const output: { system: string[] } = { system: [] };
      await plugin["experimental.chat.system.transform"](null, output);
      return output.system.join("\n");
    };
    try {
      expect(await (await fetch(`${base}/workspace/ws_1/personalization`, { headers })).json()).toEqual({ customInstructions: "", revision: 0 });
      expect((await write("ws_1", "  Use formal British English.  ")).status).toBe(200);
      expect((await write("ws_2", "Use short German paragraphs.")).status).toBe(200);
      expect(await readLegalworkWorkspaceConfig(config, "ws_1")).toEqual({ unrelated: "keep" });
      expect((await readProjectDetails(workspace)).personalizationPrompt).toBe("Use formal British English.");
      const metadata = await readProjectDetails(workspace);
      await updateProjectDetails(workspace, { revision: metadata.revision, fields: [{ id: "client", label: "Client", type: "text", value: "Acme" }] });
      expect((await readProjectDetails(workspace)).personalizationPrompt).toBe("Use formal British English.");
      expect(await prompt(firstPlugin)).toContain("Use formal British English.");
      expect(await prompt(firstPlugin)).not.toContain("Use short German paragraphs.");
      expect(await prompt(secondPlugin)).toContain("Use short German paragraphs.");
      expect(await prompt(secondPlugin)).not.toContain("Use formal British English.");
      expect(await prompt(firstPlugin)).toContain("take precedence over conflicting global");
      expect(await prompt(await LegalWorkCapabilitiesKnowledge({ directory: root }))).not.toContain("Project personalisation");
      expect(await prompt(await LegalWorkCapabilitiesKnowledge({ directory: `${workspace}-other` }))).not.toContain("Project personalisation");

      await write("ws_1", "Prefer numbered headings.");
      expect(await prompt(firstPlugin)).toContain("Prefer numbered headings.");
      expect(await prompt(firstPlugin)).not.toContain("Use formal British English.");
      await write("ws_1", " \n ");
      expect(await prompt(firstPlugin)).not.toContain("Project personalisation");
      expect(await prompt(secondPlugin)).toContain("Use short German paragraphs.");
      expect((await readGlobalPersonalizationSettings(config)).customInstructions).toBe("");

      await server.stop();
      const restarted = await startServer(config);
      try {
        const get = await fetch(`http://127.0.0.1:${restarted.port}/workspace/ws_2/personalization`, { headers });
        expect(await get.json()).toMatchObject({ customInstructions: "Use short German paragraphs." });
      } finally {
        await restarted.stop();
      }
    } finally {
      await server.stop();
      if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
      else process.env.LEGALWORK_SERVER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
      else process.env.LEGALWORK_SERVER_TOKEN = previousToken;
    }
  });

  test("project prompt writes validate input and enforce access permissions", async () => {
    const { config } = await setup();
    const server = await startServer(config);
    const base = `http://127.0.0.1:${server.port}`;
    const path = `${base}/workspace/ws_1/personalization`;
    const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
    const write = async (body: Record<string, unknown>, auth = headers) => fetch(path, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ revision: (await readProjectDetails(config.workspaces[0]!.path)).revision, ...body }),
    });
    try {
      expect((await fetch(path)).status).toBe(401);
      for (const body of [{}, { customInstructions: 123 }, { customInstructions: null }, { customInstructions: "x".repeat(12_001) }]) {
        expect((await write(body)).status).toBe(400);
      }
      expect((await write({ customInstructions: "x".repeat(12_000) })).status).toBe(200);
      expect((await write({ revision: 0, customInstructions: "stale" })).status).toBe(409);
      expect((await write({ revision: -1, customInstructions: "test" })).status).toBe(400);
      expect((await fetch(`${base}/workspace/missing/personalization`, { headers })).status).toBe(404);
      expect((await fetch(`${base}/workspace/missing/personalization`, { method: "PUT", headers, body: JSON.stringify({ customInstructions: "test" }) })).status).toBe(404);
      const issued = await fetch(`${base}/tokens`, {
        method: "POST",
        headers: { ...headers, "x-legalwork-host-token": config.hostToken },
        body: JSON.stringify({ scope: "viewer", label: "viewer" }),
      });
      const payload: unknown = await issued.json();
      if (typeof payload !== "object" || payload === null || !("token" in payload) || typeof payload.token !== "string") throw new Error("Viewer token missing");
      expect((await write({ customInstructions: "test" }, { ...headers, authorization: `Bearer ${payload.token}` })).status).toBe(403);
      config.readOnly = true;
      expect((await write({ customInstructions: "test" })).status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});
