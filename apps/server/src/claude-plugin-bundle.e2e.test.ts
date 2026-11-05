import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync, strToU8 } from "fflate";
import type { PluginImportPreview } from "@legalwork/types/plugin-import";
import { startServer } from "./server.js";
import { parseClaudePluginSource } from "./claude-plugin-bundle.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
let previousEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv = {};
});

function setEnv(key: string, value: string) {
  if (!(key in previousEnv)) previousEnv[key] = process.env[key];
  process.env[key] = value;
}

const PLUGIN_FILES: Record<string, string> = {
  ".claude-plugin/plugin.json": JSON.stringify({
    name: "slack",
    displayName: "Slack",
    description: "Slack integration for searching messages and sending communications",
    version: "1.0.0",
  }),
  ".mcp.json": JSON.stringify({
    mcpServers: {
      slack: { url: "https://mcp.slack.com/mcp" },
      "local-helper": { command: "${CLAUDE_PLUGIN_ROOT}/bin/run" },
    },
  }),
  "skills/slack-search/SKILL.md": [
    "---",
    "name: slack-search",
    "description: Search Slack messages effectively",
    "---",
    "",
    "Use the slack MCP tools to search.",
  ].join("\n"),
  "skills/slack-search/references/tips.md": "Extra reference file.",
  "commands/standup.md": [
    "---",
    "description: Compile a standup update from Slack",
    "---",
    "",
    "Summarize recent messages.",
  ].join("\n"),
  "README.md": "# Slack plugin",
};

function startMockGithub(options?: { branch?: string }) {
  const branch = options?.branch ?? "main";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      // API: repo info
      if (url.pathname === "/repos/slackapi/slack-mcp-plugin") {
        return Response.json({ default_branch: branch });
      }
      if (url.pathname.startsWith("/repos/slackapi/slack-mcp-plugin/commits/")) {
        return decodeURIComponent(url.pathname.split("/commits/")[1] || "") === branch ? Response.json({ sha: "a".repeat(40) }) : new Response("missing", { status: 404 });
      }
      if (url.pathname.endsWith(`/zipball/${"a".repeat(40)}`)) {
        const entries = { ...PLUGIN_FILES, ".mcp.json": JSON.stringify({ mcpServers: { slack: { url: `${url.origin}/mcp` }, "local-helper": { command: "${CLAUDE_PLUGIN_ROOT}/bin/run" } } }) };
        return new Response(zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [`repo-snapshot/${path}`, strToU8(text)]))));
      }
      if (url.pathname === "/mcp" && request.method === "POST") return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock" } } });
      return Response.json({ message: "not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return server;
}

function startMockOpencode() {
  const requests: Array<{ method: string; pathname: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, pathname: url.pathname });
      if (url.pathname === "/api/config" && request.method === "GET") return Response.json([]);
      return Response.json({});
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startLegalwork(options?: { branch?: string }) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "legalwork-claude-plugin-"));
  roots.push(workspaceRoot);
  setEnv("LEGALWORK_RUNTIME_DB", join(workspaceRoot, "runtime.sqlite"));
  setEnv("XDG_CONFIG_HOME", join(workspaceRoot, "global"));

  const github = startMockGithub(options);
  setEnv("LEGALWORK_GITHUB_API_BASE", `http://127.0.0.1:${github.port}`);
  setEnv("LEGALWORK_GITHUB_RAW_BASE", `http://127.0.0.1:${github.port}`);

  const engine = startMockOpencode();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${engine.server.port}`,
      },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return {
    base: `http://127.0.0.1:${server.port}`,
    headers: { Authorization: "Bearer owt_test_token", "Content-Type": "application/json" },
    workspaceRoot,
    engine,
  };
}

describe("parseClaudePluginSource", () => {
  test("parses URL variants", () => {
    expect(parseClaudePluginSource("https://github.com/slackapi/slack-mcp-plugin")).toEqual({
      owner: "slackapi",
      repo: "slack-mcp-plugin",
      ref: null,
      dir: null,
      treeSegments: null,
    });
    expect(parseClaudePluginSource("github.com/slackapi/slack-mcp-plugin.git")).toEqual({
      owner: "slackapi",
      repo: "slack-mcp-plugin",
      ref: null,
      dir: null,
      treeSegments: null,
    });
    expect(parseClaudePluginSource("https://github.com/a/b/tree/dev/plugins/x")).toEqual({
      owner: "a",
      repo: "b",
      ref: "dev",
      dir: "plugins/x",
      treeSegments: ["dev", "plugins", "x"],
    });
    // Query strings and hash fragments are ignored.
    expect(parseClaudePluginSource("https://github.com/a/b?tab=readme-ov-file#readme")).toEqual({
      owner: "a",
      repo: "b",
      ref: null,
      dir: null,
      treeSegments: null,
    });
    expect(parseClaudePluginSource("https://github.com/a/b/tree/dev/plugins/x?x=1")).toEqual({
      owner: "a",
      repo: "b",
      ref: "dev",
      dir: "plugins/x",
      treeSegments: ["dev", "plugins", "x"],
    });
    expect(() => parseClaudePluginSource("https://gitlab.com/a/b")).toThrow();
    expect(() => parseClaudePluginSource("not a url")).toThrow();
  });
});

type PreviewResponse = { preview: { name: string; version: string | null; source: { ref: string; dir: string | null }; components: Array<{ type: string; name: string }>; review: PluginImportPreview } };
async function review(legalwork: Awaited<ReturnType<typeof startLegalwork>>, url = "https://github.com/slackapi/slack-mcp-plugin"): Promise<PreviewResponse["preview"]> {
  const response = await fetch(`${legalwork.base}/workspace/ws_1/claude-plugins`, { method: "POST", headers: legalwork.headers, body: JSON.stringify({ url, dryRun: true }) });
  expect(response.status).toBe(200);
  return (await response.json() satisfies PreviewResponse).preview;
}

describe("claude plugin bundles use the shared import lifecycle", () => {
  test("reviews an immutable full archive, preserves assets and identifies unsupported components", async () => {
    const legalwork = await startLegalwork();
    const preview = await review(legalwork);
    expect(preview.name).toBe("Slack");
    expect(preview.version).toBe("1.0.0");
    expect(preview.review.provenance?.revision).toBe("a".repeat(40));
    expect(preview.components.filter(item => item.type === "skill").map(item => item.name)).toEqual(["slack-search"]);
    expect(preview.review.connectors?.find(item => item.name === "local-helper")).toMatchObject({ status: "blocked", code: "program_missing" });
    expect(preview.review.readiness).toBe("partial");
    expect(existsSync(join(legalwork.workspaceRoot, ".opencode/imported-plugins"))).toBe(false);
  });

  test("resolves branch names containing slashes", async () => {
    const legalwork = await startLegalwork({ branch: "release/v1" });
    const preview = await review(legalwork, "https://github.com/slackapi/slack-mcp-plugin/tree/release/v1");
    expect(preview.source).toMatchObject({ ref: "release/v1", dir: null });
  });

  test("requires reviewed digest and partial consent; installs complete files and uninstalls ownership", async () => {
    const legalwork = await startLegalwork();
    const endpoint = `${legalwork.base}/workspace/ws_1/claude-plugins`;
    const url = "https://github.com/slackapi/slack-mcp-plugin";
    const send = (payload: Record<string, unknown>) => fetch(endpoint, { method: "POST", headers: legalwork.headers, body: JSON.stringify({ url, ...payload }) });
    expect((await send({})).status).toBe(409);
    const preview = await review(legalwork);
    const payload = { digest: preview.review.digest, validationId: preview.review.validationId };
    expect((await send(payload)).status).toBe(409);
    expect((await send({ ...payload, digest: "stale", acknowledgePartial: true })).status).toBe(409);
    const response = await send({ ...payload, acknowledgePartial: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    const skillFile = body.item.files.find((file: { objectType: string }) => file.objectType === "skill");
    const skillPath = join(legalwork.workspaceRoot, skillFile.path);
    expect(await readFile(skillPath, "utf8")).toContain("Search Slack messages effectively");
    expect(await readFile(join(skillPath, "../references/tips.md"), "utf8")).toBe("Extra reference file.");
    const connectorName = preview.review.connectors?.find(item => item.name === "slack")?.installedName;
    const list = await (await fetch(`${legalwork.base}/workspace/ws_1/mcp`, { headers: legalwork.headers })).json();
    expect(list.items.some((item: { name: string }) => item.name === connectorName)).toBe(true);
    expect(legalwork.engine.requests).toContainEqual({ method: "GET", pathname: "/api/config" });
    const removal = await fetch(`${legalwork.base}/workspace/ws_1/cloud-plugins/${encodeURIComponent(body.item.pluginId)}`, { method: "DELETE", headers: legalwork.headers });
    expect(removal.status).toBe(200);
    expect(existsSync(skillPath)).toBe(false);
  });
});
