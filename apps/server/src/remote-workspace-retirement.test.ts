import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerConfig } from "./config.js";
import { renameRegisteredWorkspace } from "./routes/workspaces.js";
import { startServer } from "./server.js";

test("retired remote records remain recoverable through local registry edits and are reported without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-retired-workspaces-"));
  const configPath = join(root, "server.json");
  const legacy = { id: "rem_old", name: "Old worker", path: "/remote/project", workspaceType: "remote", baseUrl: "https://retired.example", legalworkToken: "preserved-private-token" };
  const local = { id: "ws_local", name: "Local", path: root, workspaceType: "local" };
  await writeFile(configPath, JSON.stringify({ workspaces: [legacy, local], authorizedRoots: [root], autoDownloadOcr: false }));
  try {
    const config = await resolveServerConfig({ configPath, workspaces: [], token: "client-test", hostToken: "host-test", port: 0, logRequests: false });
    expect(config.workspaces.map(workspace => workspace.id)).toEqual([local.id]);
    expect(config.workspaceWarnings?.[0]).toContain("no longer supported");
    expect(JSON.stringify(config)).not.toContain(legacy.legalworkToken);
    expect(await renameRegisteredWorkspace(config, local.id, "Renamed local project")).toBe(true);
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    expect(persisted.workspaces.find((entry: { id: string }) => entry.id === legacy.id)).toEqual(legacy);
    const server = await startServer(config);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspaces`, { headers: { Authorization: "Bearer client-test" } });
      const list = await response.json();
      expect(list.items.map((entry: { id: string }) => entry.id)).toEqual([local.id]);
      expect(list.warnings[0]).toContain("no longer supported");
      expect(JSON.stringify(list)).not.toContain(legacy.legalworkToken);
    } finally { await server.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
