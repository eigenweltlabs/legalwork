import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { ensureWikiAgentToken, grantWikiAgentSession, revokeWikiAgentSession } from "../wiki/agent-access.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(change?: "revoke" | "downgrade") {
  const root = await mkdtemp(join(tmpdir(), "legalwork-saved-output-auth-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "matter"); await mkdir(directory);
  const outputPath = join(root, "tool-output", "tool_original");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "saved-output-client-fixture", hostToken: "host-fixture",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  let engineReads = 0;
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    engineReads++;
    const path = new URL(request.url).pathname;
    if (path === "/api/session/ordinary") return Response.json({ data: { id: "ordinary", location: { directory } } });
    if (path === "/api/session/ordinary/message") {
      if (change === "revoke") revokeWikiAgentSession(config, "ordinary");
      if (change === "downgrade") await grantWikiAgentSession(config, { sessionId: "ordinary", directory, scope: "viewer" });
      return Response.json({ data: [{ id: "msg_original", type: "assistant", content: [{ type: "tool", state: {
        status: "completed", metadata: { truncated: true, outputPath },
      } }] }], cursor: { next: null, previous: null } });
    }
    return Response.json({}, { status: 404 });
  } });
  cleanup.push(async () => { await engine.stop(true); });
  config.workspaces[0].baseUrl = engine.url.origin;
  const server = await startServer(config); cleanup.push(async () => { await server.stop(); });
  const token = await ensureWikiAgentToken(config);
  await grantWikiAgentSession(config, { sessionId: "ordinary", directory, scope: "collaborator" });
  const request = (sessionID = "ordinary", path = outputPath) => fetch(
    `http://127.0.0.1:${server.port}/workspace/matter/sessions/${sessionID}/tool-output/authorize?${new URLSearchParams({ outputPath: path })}`,
    { headers: { "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": "ordinary",
      "x-legalwork-wiki-agent-directory": encodeURIComponent(directory) } },
  );
  return { request, engineReads: () => engineReads };
}

test("real server authorizes an owned saved output with only the managed chat origin", async () => {
  const { request, engineReads } = await fixture();
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(engineReads()).toBe(2);
});

test("saved output scope rejects another caller before reading native history and denies an unowned output", async () => {
  const { request, engineReads } = await fixture();
  const forged = await request("unrelated");
  expect(forged.status).toBe(403);
  expect(await forged.json()).toMatchObject({ code: "wiki_agent_session_mismatch" });
  expect(engineReads()).toBe(0);
  const unowned = await request("ordinary", "/not-owned/tool_output");
  expect(unowned.status).toBe(403);
  expect(await unowned.json()).toMatchObject({ code: "tool_output_not_owned" });
});

for (const change of ["revoke", "downgrade"]) test(`saved output authorization rechecks a ${change} during the native read`, async () => {
  if (change !== "revoke" && change !== "downgrade") throw new Error("Unknown control");
  const { request, engineReads } = await fixture(change);
  const response = await request();
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: change === "revoke" ? "wiki_agent_session_unknown" : "tool_output_origin_changed" });
  expect(engineReads()).toBe(2);
});
