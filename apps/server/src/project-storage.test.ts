import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishLocalProject, localProjectMigrationPending, markLocalProjectPublished, prepareLocalProject, prepareLocalProjects, projectFilePermissionRules, workspaceFileRoot } from "./project-storage.js";
import { engineProjectStatus, writeNativeProjectProjection } from "./engine-project.js";
import { readLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import { listSkills } from "./skills.js";
import { saveEmailDraft } from "./email-drafts/store.js";
import { createLocalProjectFolder, registerLocalProject, unregisterWorkspace } from "./routes/workspaces.js";
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

test("rejects stale unpublished copies and recovers published content ownership without its drive", async () => {
  const f = await fixture();
  const local = await prepareLocalProject(f.config, f.original);
  await writeFile(join(f.source, ".legalwork", "attachments", "mail.txt"), "Newer source data");
  await expect(prepareLocalProject(f.config, f.original)).rejects.toThrow("diverged");
  expect(await readFile(join(local.path, ".legalwork", "attachments", "mail.txt"), "utf8")).toBe("Retained attachment");
  await markLocalProjectPublished(local);
  await writeFile(join(local.path, ".legalwork", "attachments", "mail.txt"), "Committed local work");
  expect((await prepareLocalProject(f.config, f.original)).path).toBe(local.path);
  await rm(f.source, { recursive: true });
  f.config.workspaces = [];
  const recovered = (await registerLocalProject(f.config, { id: local.id, folderPath: local.path, name: "Recovered", preset: "starter" })).workspace;
  expect(recovered).toMatchObject({ id: local.id, path: local.path, contentPath: f.source, previousPath: f.source });
  expect(await readFile(join(local.path, ".legalwork", "attachments", "mail.txt"), "utf8")).toBe("Committed local work");
});

test("leaves root configurations untouched without copying them into the local engine home", async () => {
  const f = await fixture();
  const raw = JSON.stringify({ agents: { original: { system: `{file:${join(f.source, ".legalwork", "attachments", "mail.txt")}}`, mode: "subagent" } }, instructions: ["Rules.md"], plugins: ["./custom.mjs"], mcp: { servers: { fixture: { type: "local", command: ["node", "server.mjs"], cwd: "mcp" } } } });
  for (const name of ["opencode.json", "opencode.jsonc"]) await writeFile(join(f.source, name), raw);
  for (const folder of ["Skills/visible", ".claude/skills/claude", ".agents/skills/agents", ".opencode/skills/native"]) {
    await mkdir(join(f.source, folder), { recursive: true });
    await writeFile(join(f.source, folder, "SKILL.md"), `---\nname: ${folder.split("/").at(-1)}\ndescription: Existing capability\n---\nInstructions.\n`);
  }
  const local = await prepareLocalProject(f.config, f.original);
  await markLocalProjectPublished(local);
  f.config.workspaces = [local];
  const projection = await writeNativeProjectProjection(f.config, local, {});
  expect(projection.startsWith(join(local.path, ".opencode"))).toBe(true);
  for (const name of ["opencode.json", "opencode.jsonc"]) expect(await readFile(join(f.source, name), "utf8")).toBe(raw);
  for (const path of ["opencode.json", "opencode.jsonc", ".opencode/legalwork/connected-config.json", ".opencode/legalwork/connected-config-cache"]) {
    expect(await stat(join(local.path, path)).catch(() => null)).toBeNull();
  }
  expect((await listSkills(local, false)).map(skill => skill.name)).toEqual(expect.arrayContaining(["visible", "claude", "agents", "native"]));
  await rm(f.source, { recursive: true });
  expect(await writeNativeProjectProjection(f.config, local, {})).toBe(projection);
});

test("email drafts snapshot both connected documents and retained local attachments", async () => {
  const f = await fixture(), local = await prepareLocalProject(f.config, f.original);
  const draft = await saveEmailDraft(local.path, local.id, { from: "", replyTo: "", to: "client@example.invalid", cc: "", bcc: "", subject: "Matter", body: "Attached", html: "", attachments: [
    { path: "contract.txt", contentType: "text/plain" }, { path: ".legalwork/attachments/mail.txt", contentType: "text/plain" },
  ] }, undefined, undefined, local.contentPath);
  const bytes = await readFile(join(local.path, draft.path), "utf8");
  expect(bytes).toContain(Buffer.from("Original document").toString("base64"));
  expect(bytes).toContain(Buffer.from("Retained attachment").toString("base64"));
  expect(await stat(join(f.source, draft.path)).catch(() => null)).toBeNull();
});

test("preserves generated configuration ownership when migrating a folder alias", async () => {
  const f = await fixture(), alias = join(f.root, "selected-matter");
  await symlink(f.source, alias, process.platform === "win32" ? "junction" : "dir");
  f.original.path = alias;
  const originalProjection = await writeNativeProjectProjection(f.config, f.original, {});
  const authored = join(f.source, ".opencode", "opencode.jsonc");
  await writeFile(authored, "// Authored settings\n{}");
  expect(await prepareLocalProjects(f.config)).toBe(true);
  const local = f.config.workspaces[0]!;
  const projection = join(local.path, ".opencode", "opencode.json");
  expect(originalProjection).toBe(join(f.source, ".opencode", "opencode.json"));
  expect((await readLegalworkWorkspaceConfig(f.config, local.id)).nativeEngineProject).toMatchObject({ directory: local.path, projection: { path: projection } });
  expect(await writeNativeProjectProjection(f.config, local, {})).toBe(projection);
  expect((await engineProjectStatus(f.config, local)).state).toBe("ready");
  expect(await readFile(join(local.path, ".opencode", "opencode.jsonc"), "utf8")).toBe("// Authored settings\n{}");
});

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
  const generic = { action: "*", resource: "curl *", effect: "deny" };
  const aliases = projectFilePermissionRules(workspace, [generic]);
  expect(aliases[0]).toEqual(generic);
  expect(aliases.slice(1).map(rule => rule.action)).toEqual(["read", "edit", "list", "external_directory"]);
});

test("re-adding the original folder or a default files folder preserves retained identity and local changes", async () => {
  const f = await fixture();
  const local = await prepareLocalProject(f.config, f.original);
  await markLocalProjectPublished(local); await finishLocalProject(local);
  await writeFile(join(local.path, ".legalwork", "attachments", "mail.txt"), "New local work");
  f.config.workspaces = [local];
  await unregisterWorkspace(f.config, local);
  const restored = (await registerLocalProject(f.config, { folderPath: f.source, name: "Reopened", preset: "starter" })).workspace;
  expect(restored).toMatchObject({ id: local.id, path: local.path, contentPath: f.source });
  expect(await readFile(join(restored.path, ".legalwork", "attachments", "mail.txt"), "utf8")).toBe("New local work");
  const folder = await createLocalProjectFolder(f.config, "Default matter");
  const created = (await registerLocalProject(f.config, { ...folder, name: "Default matter", preset: "starter" })).workspace;
  await unregisterWorkspace(f.config, created);
  expect((await registerLocalProject(f.config, { folderPath: created.contentPath!, name: "Default again", preset: "starter" })).workspace.id).toBe(created.id);
});

test("file APIs read and write connected documents and local attachments, including legacy absolute links", async () => {
  const f = await fixture();
  expect(await prepareLocalProjects(f.config)).toBe(true);
  const local = f.config.workspaces[0]!;
  await finishLocalProject(local);
  const folder = await createLocalProjectFolder(f.config, "Default");
  const standard = (await registerLocalProject(f.config, { ...folder, name: "Default", preset: "starter" })).workspace;
  await writeFile(join(standard.contentPath!, "contract.txt"), "Default document");
  await writeFile(join(standard.path, "engine-result.txt"), "Native result");
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
  const standardBase = `http://127.0.0.1:${server.port}/workspace/${standard.id}`;
  for (const path of ["contract.txt", join(standard.contentPath!, "contract.txt")]) {
    const response = await fetch(`${standardBase}/files/raw?path=${encodeURIComponent(path)}`, { headers });
    expect(response.status).toBe(200); expect(await response.text()).toBe("Default document");
  }
  const nativeArtifact = await fetch(`${standardBase}/artifacts/resolve`, { method: "POST", headers, body: JSON.stringify({ targets: [{ value: "engine-result.txt", reason: "write tool metadata" }] }) });
  const artifact = (await nativeArtifact.json()).items[0];
  expect(artifact).toMatchObject({ value: join(standard.path, "engine-result.txt"), exists: true });
  expect(await (await fetch(`${standardBase}/files/raw?path=${encodeURIComponent(artifact.value)}`, { headers })).text()).toBe("Native result");
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
