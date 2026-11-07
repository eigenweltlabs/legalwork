import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishLocalProject, localProjectMigrationPending, prepareLocalProject, prepareLocalProjects, projectFilePermissionRules, workspaceFileRoot } from "./project-storage.js";
import { createLocalProjectFolder, registerLocalProject } from "./routes/workspaces.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-local-project-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "connected");
  await mkdir(join(source, ".opencode", "reviews"), { recursive: true });
  await mkdir(join(source, ".legalwork", "attachments"), { recursive: true });
  await writeFile(join(source, "contract.txt"), "Original document");
  await writeFile(join(source, ".opencode", "reviews", "saved.json"), '{"id":"kept"}');
  await writeFile(join(source, ".legalwork", "attachments", "mail.txt"), "Retained attachment");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test-client", hostToken: "test-host", configPath: join(root, "server.json"),
    projectsDirectory: join(root, "local-projects"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [{ id: "ws_existing", name: "Matter", path: source, workspaceType: "local", preset: "starter" }],
    authorizedRoots: [source], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  return { root, source, config, original: config.workspaces[0]! };
}

test("moves only the two support trees, preserves linked targets and IDs, and keeps a local recovery copy", async () => {
  const f = await fixture();
  await symlink("../../contract.txt", join(f.source, ".legalwork", "attachments", "document-link.txt"));
  await symlink(join(f.source, ".legalwork", "attachments", "mail.txt"), join(f.source, ".opencode", "mail-link.txt"));
  const local = await prepareLocalProject(f.config, f.original);
  expect(local.id).toBe(f.original.id);
  expect(local.contentPath).toBe(f.source);
  expect(await readFile(join(local.path, ".opencode", "reviews", "saved.json"), "utf8")).toBe('{"id":"kept"}');
  expect(await stat(join(local.path, "contract.txt")).catch(() => null)).toBeNull();
  expect(await localProjectMigrationPending(local)).toBe(true);
  expect(await prepareLocalProject(f.config, f.original)).toEqual(local);
  await finishLocalProject(local);
  expect(await localProjectMigrationPending(local)).toBe(false);
  expect(await readFile(join(f.source, "contract.txt"), "utf8")).toBe("Original document");
  for (const folder of [".opencode", ".legalwork"]) expect(await stat(join(f.source, folder)).catch(() => null)).toBeNull();
  expect(await readFile(join(local.path, ".opencode", "mail-link.txt"), "utf8")).toBe("Retained attachment");
  expect(await readFile(join(local.path, ".legalwork", "attachments", "document-link.txt"), "utf8")).toBe("Original document");
  expect(await readFile(join(local.path, ".project-storage-backup", ".legalwork", "attachments", "mail.txt"), "utf8")).toBe("Retained attachment");
  const second = await prepareLocalProject({ ...f.config, projectsDirectory: join(f.root, "second-installation") }, f.original);
  expect(await readFile(join(second.path, ".legalwork", "attachments", "mail.txt"), "utf8")).toBe("Retained attachment");
  // A disconnected content drive never forces a completed project back to its old home.
  f.config.workspaces = [local];
  await rm(f.source, { recursive: true });
  expect(await prepareLocalProjects(f.config)).toBe(false);
  expect(f.config.workspaces[0]?.path).toBe(local.path);
});

test("never merges an unowned destination or deletes support data changed after cutover", async () => {
  const f = await fixture();
  const local = await prepareLocalProject(f.config, f.original);
  await writeFile(join(f.source, ".legalwork", "attachments", "mail.txt"), "Changed externally");
  await finishLocalProject(local);
  expect(await readFile(join(f.source, ".legalwork", "attachments", "mail.txt"), "utf8")).toBe("Changed externally");
  expect(await readFile(join(local.path, ".legalwork", "attachments", "mail.txt"), "utf8")).toBe("Retained attachment");
  const other = { ...f.original, id: "ws_conflict" };
  await mkdir(join(f.config.projectsDirectory!, other.id));
  await expect(prepareLocalProject(f.config, other)).rejects.toThrow("already exists");
});

test("default creation allocates documents inside files and keeps path permissions scoped to the connected folder", async () => {
  const f = await fixture();
  const folder = await createLocalProjectFolder(f.config, "New matter");
  const { workspace } = await registerLocalProject(f.config, { ...folder, name: "New matter", preset: "starter" });
  expect(workspace.path).toBe(join(f.config.projectsDirectory!, workspace.id));
  expect(workspace.contentPath).toBe(join(workspace.path, "files"));
  expect(workspace.previousPath).toBeUndefined();
  if (process.platform !== "win32") expect((await stat(workspace.path)).mode & 0o777).toBe(0o700);
  expect(workspaceFileRoot(workspace, ".legalwork/attachments/a.pdf")).toBe(workspace.path);
  expect(workspaceFileRoot(workspace, "contract.txt")).toBe(workspace.contentPath!);
  const rules = projectFilePermissionRules(workspace, [{ action: "read", resource: "private/*", effect: "deny" }]);
  expect(rules).toContainEqual({ action: "read", resource: `${workspace.contentPath}/private/*`, effect: "deny" });
});

test("file APIs read and write connected documents and local attachments, including legacy absolute links", async () => {
  const f = await fixture();
  expect(await prepareLocalProjects(f.config)).toBe(true);
  const local = f.config.workspaces[0]!;
  await finishLocalProject(local);
  f.config.projectStorageMigrating = true;
  const server = await startServer(f.config, { onListening: async port => {
    const root = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${f.config.token}` };
    // Project reads initialize bundled files; they must wait until copying ends.
    const pending = await fetch(`${root}/workspace/${local.id}/sessions`, { headers });
    expect(pending.status).toBe(503);
    expect((await pending.json()).code).toBe("project_storage_migrating");
    expect((await fetch(`${root}/workspaces`, { headers })).status).toBe(200);
    f.config.projectStorageMigrating = false;
  } });
  cleanups.push(async () => { await server.stop(); });
  const base = `http://127.0.0.1:${server.port}/workspace/${local.id}`;
  const headers = { Authorization: `Bearer ${f.config.token}`, "Content-Type": "application/json" };
  for (const [path, content] of [["contract.txt", "Original document"], [".legalwork/attachments/mail.txt", "Retained attachment"]]) {
    const response = await fetch(`${base}/files/content?path=${encodeURIComponent(path!)}`, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).content).toBe(content);
  }
  const saved = await fetch(`${base}/files/content`, { method: "POST", headers, body: JSON.stringify({ path: "new.txt", content: "New document" }) });
  expect(saved.status).toBe(200);
  expect(await readFile(join(f.source, "new.txt"), "utf8")).toBe("New document");
  expect(await stat(join(local.path, "new.txt")).catch(() => null)).toBeNull();
  const resolved = await fetch(`${base}/artifacts/resolve`, { method: "POST", headers, body: JSON.stringify({ targets: [{ kind: "file", value: join(f.source, ".legalwork/attachments/mail.txt") }, { kind: "file", value: join(f.source, "contract.txt") }] }) });
  expect((await resolved.json()).items.map((item: {value: string; exists: boolean}) => [item.value, item.exists])).toEqual([[".legalwork/attachments/mail.txt", true], ["contract.txt", true]]);
  await rm(f.source, { recursive: true });
  const retained = await fetch(`${base}/files/content?path=.legalwork%2Fattachments%2Fmail.txt`, { headers });
  expect(retained.status).toBe(200);
});
