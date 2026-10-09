import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "./server.js";
import type { ServerConfig } from "./types.js";

let server: StartedServer | undefined;
let root = "";
const previousDataDir = process.env.LEGALWORK_DATA_DIR;
afterEach(async () => {
  await server?.stop(); server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.LEGALWORK_DATA_DIR;
  else process.env.LEGALWORK_DATA_DIR = previousDataDir;
});
test("a missing project folder can be removed from the registry without recreating it or touching other files", async () => {
  root = await mkdtemp(join(tmpdir(), "legalwork-remove-project-"));
  process.env.LEGALWORK_DATA_DIR = join(root, "data");
  const missing = join(root, "disconnected"), kept = join(root, "kept"), configPath = join(root, "server.json");
  await mkdir(kept); await writeFile(join(kept, "keep.txt"), "Original");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test-client", hostToken: "test-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [{ id: "missing", name: "Missing", path: missing, preset: "starter", workspaceType: "local" }, { id: "kept", name: "Kept", path: kept, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [missing, kept], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, configPath,
  };
  await writeFile(configPath, JSON.stringify({ workspaces: config.workspaces, authorizedRoots: config.authorizedRoots }));
  server = await startServer(config);
  const url = `http://127.0.0.1:${server.port}/workspaces/missing`;
  const denied = await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer test-client" } });
  expect(denied.status).toBe(401); await denied.arrayBuffer();
  const removed = await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer test-client", "X-LegalWork-Host-Token": "test-host" } });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ deleted: true, persisted: true, items: [{ id: "kept" }] });
  expect(JSON.parse(await readFile(configPath, "utf8")).workspaces.map((item: { id: string }) => item.id)).toEqual(["kept"]);
  expect(await readFile(join(kept, "keep.txt"), "utf8")).toBe("Original");
  expect(await stat(missing).catch(() => null)).toBeNull();
});
