import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { writeNativeProjectProjection } from "./engine-project.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

test("recovery controls reject retired credentials and expose only the selected project's recovery state", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-project-recovery-routes-")));
  const project = join(root, "project"); await mkdir(project);
  const previousTokens = process.env.LEGALWORK_TOKEN_STORE, previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  let retried = 0;
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "synthetic-owner", hostToken: "synthetic-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [project], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    engineProjectTrustRequired: true, retryManagedEngineRecovery: async () => { retried++; },
    managedEngineRecoveryState: () => ({ mode: "recovery", heldSessions: [{ id: "own-held-chat", directory: project }, { id: "secret-other-chat", directory: join(root, "secret-other-project") }],
      error: { code: "private_failure", message: "secret-other-project private credentials" } }),
  };
  const retiredViewerToken = "owt_retired_viewer";
  await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { read: "ask" } }));
  const projection = await writeNativeProjectProjection(config, config.workspaces[0]!, {
    permissions: [{ action: "read", resource: "*", effect: "ask" }],
  });
  const original = await readFile(projection, "utf8");
  const server = await startServer(config);
  const request = (suffix: string, token?: string, method = "GET") => fetch(`http://127.0.0.1:${server.port}/workspace/${suffix}`, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  try {
    const saved = await request("matter/config", config.token);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ opencode: { permissions: [{ action: "read", resource: "*", effect: "ask" }] } });
    const rawURL = `http://127.0.0.1:${server.port}/workspace/matter/opencode-config`;
    const hostHeaders = { "x-legalwork-host-token": config.hostToken };
    expect(await (await fetch(rawURL, { headers: hostHeaders })).json()).toMatchObject({ path: projection, readOnly: true });
    const edit = await fetch(rawURL, { method: "POST", headers: { ...hostHeaders, "content-type": "application/json" }, body: JSON.stringify({ content: "{}" }) });
    expect(edit.status).toBe(409);
    expect(await readFile(projection, "utf8")).toBe(original);
    expect((await request("matter/engine-project")).status).toBe(401);
    expect((await request("matter/engine-project", retiredViewerToken)).status).toBe(401);
    const visible = await request("matter/engine-project", config.token);
    expect(visible.status).toBe(200);
    expect(visible.headers.get("cache-control")).toBe("no-store");
    const state = await visible.text();
    expect(state).toContain("own-held-chat");
    expect(state).toContain('"waitingForOtherProjects":true');
    expect(state).not.toContain("secret-other");
    expect(state).not.toContain("private credentials");
    expect((await request("matter/engine-project/retry-recovery", retiredViewerToken, "POST")).status).toBe(401);
    expect(retried).toBe(0);
    expect((await request("missing/engine-project/retry-recovery", config.token, "POST")).status).toBe(404);
    expect(retried).toBe(0);
    const retriedResponse = await request("matter/engine-project/retry-recovery", config.token, "POST");
    expect(retriedResponse.status).toBe(200);
    expect(retriedResponse.headers.get("cache-control")).toBe("no-store");
    expect(retried).toBe(1);
    config.readOnly = true;
    expect((await request("matter/engine-project/retry-recovery", config.token, "POST")).status).toBe(403);
    expect(retried).toBe(1);
  } finally {
    await server.stop();
    if (previousTokens === undefined) delete process.env.LEGALWORK_TOKEN_STORE; else process.env.LEGALWORK_TOKEN_STORE = previousTokens;
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});
