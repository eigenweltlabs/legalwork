import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { completeProjectMigrationProgress, finishLocalProject, localProjectMigrationPending, markLocalProjectPublished, prepareLocalProject, prepareLocalProjects, projectFilePermissionRules, workspaceFileRoot } from "./project-storage.js";
import { engineProjectStatus, writeNativeProjectProjection } from "./engine-project.js";
import { readLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import { listSkills } from "./skills.js";
import { saveEmailDraft } from "./email-drafts/store.js";
import { createLocalProjectFolder, registerLocalProject, unregisterWorkspace } from "./routes/workspaces.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import type { MigrationProgress } from "@legalwork/types/migration-progress";
import { closeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

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

test("migration prunes dependencies and caches before reading them, including recovery backups and progress", async () => {
  const f = await fixture();
  const omitted = [
    ".opencode/node_modules", ".legalwork/scratch/node_modules", ".legalwork/scratch/.pnpm-store",
    ".legalwork/scratch/python-env", ".legalwork/scratch/.venv", ".legalwork/scratch/venv",
    ...["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".parcel-cache", ".vite"].map(name => `.legalwork/scratch/${name}`),
    ".legalwork/scratch/.npm/_cacache", ".legalwork/scratch/.yarn/cache", ".legalwork/scratch/.next/cache", ".legalwork/scratch/.cache/uv",
    ...["pip-cache", ".cache/pip"].flatMap(parent => ["http", "http-v2", "wheels", "selfcheck"].map(name => `.legalwork/scratch/${parent}/${name}`)),
    ...["chrome-profile", "browser-profile/Default"].flatMap(parent => ["Cache", "Code Cache", "GPUCache", "GPUPersistentCache", "ShaderCache", "GrShaderCache", "DawnCache", "DawnGraphiteCache", "GraphiteDawnCache", "component_crx_cache"].map(name => `.legalwork/scratch/${parent}/${name}`)),
  ];
  for (const path of omitted) {
    await mkdir(join(f.source, path), { recursive: true });
    await writeFile(join(f.source, path, "installed.bin"), Buffer.alloc(8192, 7));
  }
  for (const name of ["python-env", ".venv", "venv"]) await writeFile(join(f.source, ".legalwork/scratch", name, "pyvenv.cfg"), "home = old-machine\n");
  // A traversed FIFO would reject hashing (or block a content read). It must
  // never be visited, even when checking originals again or making backups.
  if (process.platform !== "win32") {
    for (const path of [".opencode/node_modules", ".legalwork/scratch/python-env"]) {
      expect(spawnSync("mkfifo", [join(f.source, path, "unreadable-payload")]).status).toBe(0);
    }
  }
  const kept = [".opencode/package.json", ".opencode/package-lock.json", ".legalwork/.env", ".legalwork/scratch/script.py", ".legalwork/scratch/requirements.txt", ".legalwork/scratch/poetry.lock",
    ".legalwork/downloads/file.pdf", ".legalwork/scratch/build/output.pdf", ".legalwork/scratch/dist/output.docx", ".legalwork/scratch/tmp/draft.txt", ".legalwork/scratch/vendor/library.js", ".legalwork/scratch/.git/objects/pack/history.pack",
    ".legalwork/skills/pdf/assets/vendor/pdf.min.js", ".legalwork/scratch/chrome-profile/Default/Cookies", ".legalwork/scratch/browser-profile/Default/Preferences", ".legalwork/scratch/chrome-profile/Downloads/Cache/document.txt", ".legalwork/scratch/browser-profile/Default/Downloads/GPUCache/document.txt", ".legalwork/scratch/Cache/document.txt", ".legalwork/scratch/files/node_modules"];
  for (const path of kept) {
    await mkdir(dirname(join(f.source, path)), { recursive: true });
    await writeFile(join(f.source, path), `Keep ${path}`);
  }
  const snapshots: MigrationProgress[] = [];
  Object.defineProperty(f.config, "migrationProgress", { get: () => snapshots.at(-1), set: (value: MigrationProgress) => { snapshots.push(value); } });
  f.config.projectStorageMigrating = true;
  const local = await prepareLocalProject(f.config, f.original);
  const copyCounts = snapshots.filter(item => item.phase === "copying" && item.work?.unit === "files" && item.work.completed === item.work.total).map(item => item.work?.total);
  expect(copyCounts).toEqual([3, kept.length - 2 + 1]);
  await writeFile(join(f.source, omitted[0]!, "changed.txt"), "Excluded changes do not invalidate the retained copy");
  expect(await prepareLocalProject(f.config, f.original)).toEqual(local);
  await finishLocalProject(local, f.config);
  for (const root of [local.path, join(local.path, ".project-storage-backup")]) {
    for (const path of omitted) expect(await lstat(join(root, path)).catch(() => null)).toBeNull();
    for (const path of kept) expect(await readFile(join(root, path), "utf8")).toBe(`Keep ${path}`);
    expect(await readFile(join(root, ".legalwork/attachments/mail.txt"), "utf8")).toBe("Retained attachment");
    expect((await readdir(join(root, ".legalwork/scratch/python-env")).catch(() => []))).toEqual([]);
  }
  expect(await readFile(join(f.source, ".opencode.legalwork-migrated/node_modules/installed.bin"))).toEqual(Buffer.alloc(8192, 7));
  expect(await readFile(join(f.source, ".legalwork.legalwork-migrated/scratch/python-env/pyvenv.cfg"), "utf8")).toBe("home = old-machine\n");
});

test("environment links are omitted without following targets and .env configuration links are retained", async () => {
  const f = await fixture();
  const external = join(f.root, "external-environment");
  await mkdir(external);
  await writeFile(join(external, "pyvenv.cfg"), "External environment");
  for (const name of [".venv", "venv", "node_modules"]) await symlink(external, join(f.source, ".legalwork", name), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(f.source, "config.env"), "KEY=keep");
  await symlink("../config.env", join(f.source, ".legalwork", ".env"));
  const local = await prepareLocalProject(f.config, f.original);
  for (const name of [".venv", "venv", "node_modules"]) expect(await lstat(join(local.path, ".legalwork", name)).catch(() => null)).toBeNull();
  expect(await readFile(join(local.path, ".legalwork", ".env"), "utf8")).toBe("KEY=keep");
  expect(await readFile(join(external, "pyvenv.cfg"), "utf8")).toBe("External environment");
});

test.each([false, true])("old unpublished copies adopt exclusions only when retained data agrees (divergent: %s)", async divergent => {
  const f = await fixture();
  await symlink("../../contract.txt", join(f.source, ".legalwork/attachments/document-link"));
  await symlink(join(f.source, ".legalwork/attachments/mail.txt"), join(f.source, ".opencode/mail-link"));
  const local = await prepareLocalProject(f.config, f.original);
  const path = join(local.path, ".project-storage-migration.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  delete receipt.exclusionsVersion;
  // V1 hashes cover dependency bytes too, so cannot serve as the filtered
  // baseline. Source and owned copy must be compared without those payloads.
  receipt.fingerprints = { ".opencode": "legacy-full-tree-hash", ".legalwork": "legacy-full-tree-hash" };
  receipt.copiedFingerprints = receipt.fingerprints;
  await writeFile(path, JSON.stringify(receipt));
  for (const root of [f.source, local.path]) {
    await mkdir(join(root, ".opencode/node_modules"));
    await writeFile(join(root, ".opencode/node_modules/old-install.txt"), root);
    if (process.platform !== "win32") expect(spawnSync("mkfifo", [join(root, ".opencode/node_modules/unreadable-payload")]).status).toBe(0);
  }
  if (divergent) {
    await writeFile(join(f.source, ".legalwork/attachments/mail.txt"), "Newer source work");
    await expect(prepareLocalProject(f.config, f.original)).rejects.toThrow("diverged");
    expect(JSON.parse(await readFile(path, "utf8")).exclusionsVersion).toBeUndefined();
    expect(await readFile(join(local.path, ".legalwork/attachments/mail.txt"), "utf8")).toBe("Retained attachment");
  } else {
    expect(await prepareLocalProject(f.config, f.original)).toEqual(local);
    expect(JSON.parse(await readFile(path, "utf8")).exclusionsVersion).toBe(1);
    expect(await readFile(join(local.path, ".legalwork/attachments/document-link"), "utf8")).toBe("Original document");
    await finishLocalProject(local);
    expect(await lstat(join(local.path, ".project-storage-backup/.opencode/node_modules")).catch(() => null)).toBeNull();
  }
  expect(await readFile(join(local.path, ".opencode/node_modules/old-install.txt"), "utf8")).toBe(local.path);
});

test("a published legacy migration keeps its original recovery tree without hashing omitted payloads", async () => {
  const f = await fixture(), local = await prepareLocalProject(f.config, f.original);
  const path = join(local.path, ".project-storage-migration.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  delete receipt.exclusionsVersion;
  receipt.published = true;
  await writeFile(path, JSON.stringify(receipt));
  await mkdir(join(f.source, ".opencode/node_modules"));
  if (process.platform !== "win32") expect(spawnSync("mkfifo", [join(f.source, ".opencode/node_modules/payload")]).status).toBe(0);
  await writeFile(join(local.path, ".legalwork/attachments/mail.txt"), "New local work");
  expect(await prepareLocalProject(f.config, f.original)).toEqual(local);
  await finishLocalProject(local);
  expect(await localProjectMigrationPending(local)).toBe(false);
  expect(await readFile(join(f.source, ".legalwork/attachments/mail.txt"), "utf8")).toBe("Retained attachment");
  expect(await readFile(join(local.path, ".legalwork/attachments/mail.txt"), "utf8")).toBe("New local work");
  expect(await stat(join(f.source, ".opencode/node_modules"))).toBeDefined();
});

test("migration reports completed copy/hash work while retaining file metadata and link ownership", async () => {
  const f = await fixture();
  const payload = Buffer.alloc(256 * 1024, 47);
  await writeFile(join(f.source, ".legalwork", "attachments", "payload.bin"), payload);
  const script = join(f.source, ".opencode", "reviews", "run.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  await chmod(script, 0o751);
  const timestamp = new Date("2020-01-02T03:04:05Z");
  await utimes(script, timestamp, timestamp);
  await symlink("mail.txt", join(f.source, ".legalwork", "attachments", "pointer"));
  const snapshots: MigrationProgress[] = [];
  Object.defineProperty(f.config, "migrationProgress", {
    get: () => snapshots.at(-1), set: (value: MigrationProgress) => { snapshots.push(value); },
  });
  f.config.projectStorageMigrating = true;
  expect(await prepareLocalProjects(f.config)).toBe(true);
  const local = f.config.workspaces[0];
  const copies = snapshots.filter(item => item.phase === "copying" && item.work?.unit === "files");
  expect(copies.some(item => item.work?.total && item.work.completed === item.work.total)).toBe(true);
  expect(snapshots.some(item => item.phase === "verifying" && item.work?.unit === "bytes" && item.work.total !== undefined && item.work.total >= payload.length && item.work.completed === item.work.total)).toBe(true);
  expect(copies.every(item => item.project?.index === 1 && item.project.total === 1)).toBe(true);
  expect(await readFile(join(local.path, ".legalwork", "attachments", "payload.bin"))).toEqual(payload);
  expect(await readFile(join(local.path, ".legalwork", "attachments", "pointer"), "utf8")).toBe("Retained attachment");
  const copiedScript = await stat(join(local.path, ".opencode", "reviews", "run.sh"));
  if (process.platform !== "win32") expect(copiedScript.mode & 0o777).toBe(0o751);
  expect(copiedScript.mtimeMs).toBe(timestamp.getTime());
  expect(await readFile(join(f.source, "contract.txt"), "utf8")).toBe("Original document");
  expect(await stat(join(local.path, "contract.txt")).catch(() => null)).toBeNull();
});

test("migration progress is authenticated and keeps health migrating while file work is active", async () => {
  const f = await fixture();
  f.config.engineProjectTrustRequired = true;
  const server = await startServer(f.config);
  cleanups.push(async () => { await server.stop(); await closeRuntimeOpencodeConfig(f.config); });
  f.config.managedEngineStatus = "ready";
  f.config.migrationProgress = { status: "running", phase: "copying", project: { name: "Confidential migration fixture", index: 1, total: 2 }, work: { completed: 3, total: 8, unit: "files" }, deferredProjects: 0 };
  const base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(base + "/migration/progress")).status).toBe(401);
  const health = await (await fetch(base + "/health")).json();
  expect(health).toMatchObject({ engine: { status: "migrating" } });
  expect(JSON.stringify(health)).not.toContain("Confidential");
  const progress = await fetch(base + "/migration/progress", { headers: { authorization: "Bearer test-client" } });
  expect(progress.status).toBe(200);
  expect(await progress.json()).toEqual({ migration: f.config.migrationProgress });
  await completeProjectMigrationProgress(f.config);
  expect(f.config.migrationProgress).toMatchObject({ status: "waiting", deferredProjects: 1, phase: "finishing" });
  const local = await prepareLocalProject(f.config, f.original);
  f.config.workspaces = [local];
  await finishLocalProject(local);
  await completeProjectMigrationProgress(f.config);
  expect(f.config.migrationProgress).toMatchObject({ status: "complete", deferredProjects: 0 });
  expect(await (await fetch(base + "/health")).json()).toMatchObject({ engine: { status: "ready" } });
});

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
  const fileSession = await (await fetch(`${standardBase}/files/sessions`, { method: "POST", headers, body: JSON.stringify({ write: true }) })).json();
  const renamedPath = join(standard.path, "renamed-result.txt");
  const renamed = await fetch(`http://127.0.0.1:${server.port}/files/sessions/${fileSession.session.id}/ops`, {
    method: "POST", headers, body: JSON.stringify({ operations: [{ type: "rename", from: artifact.value, to: renamedPath }] }),
  });
  expect(renamed.status).toBe(200);
  expect((await renamed.json()).items[0].ok).toBe(true);
  expect(await readFile(renamedPath, "utf8")).toBe("Native result");
  expect(await stat(artifact.value).catch(() => null)).toBeNull();
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
