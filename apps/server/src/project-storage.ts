import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { workspaceContentPath, workspaceFileRoot } from "./project-storage-paths.js";
import { ApiError } from "./errors.js";
import { readLegalworkWorkspaceConfig, writeLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import { canonicalFilePath, withFileWriteLock } from "./file-write-lock.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { projectPathKey } from "./workspace-path-match.js";

export { workspaceContentPath, workspaceFileRoot };
const folders = [".opencode", ".legalwork"];
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const receiptSchema = z.object({ version: z.literal(1), id: z.string(), source: z.string(), sourceAliases: z.array(z.string()).optional(), fingerprints: z.record(z.string(), z.string()), copiedFingerprints: z.record(z.string(), z.string()).optional(), published: z.boolean().optional(), complete: z.boolean(), referencesComplete: z.boolean().optional(), cleanupComplete: z.boolean().optional() });
const receiptPath = (root: string) => join(root, ".project-storage-migration.json");

/** Independently local project data; never derive this from Documents. */
export function localProjectsDirectory(): string {
  const explicit = process.env.LEGALWORK_PROJECT_DATA_DIR?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("LEGALWORK_PROJECT_DATA_DIR must be an absolute local directory.");
    return explicit;
  }
  const identity = process.env.LEGALWORK_DEV_MODE === "1" ? "com.eigenweltlabs.legalwork.dev" : "com.eigenweltlabs.legalwork";
  const parent = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(parent, identity, "Projects");
}

export function projectHome(config: Pick<ServerConfig, "projectsDirectory">, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ApiError(400, "invalid_project_id", "Project identity cannot be used as a local directory.");
  return join(config.projectsDirectory || localProjectsDirectory(), id);
}

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string, name: string): Promise<void> {
    const info = await lstat(path);
    hash.update(JSON.stringify([name, info.mode]));
    if (info.isSymbolicLink()) { hash.update("link:").update(await readlink(path)); return; }
    if (info.isDirectory()) {
      hash.update("directory:");
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), `${name}/${entry}`);
    } else if (info.isFile()) {
      hash.update(`file:${info.size}:`);
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } else throw new Error("Project support data contains an unsupported special file; the original was preserved.");
  }
  if (!await lstat(root).then(() => true, error => { if (missing(error)) return false; throw error; })) return "missing";
  await walk(root, "");
  return hash.digest("hex");
}

async function relocateSupportLinks(staging: string, source: string, target: string): Promise<void> {
  async function walk(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const originalPath = join(source, relative(staging, path));
      const destination = resolve(dirname(originalPath), await readlink(path));
      const suffix = relative(source, destination);
      const linked = /^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix) ? join(target, suffix) : destination;
      await rm(path);
      const directory = await stat(destination).then(info => info.isDirectory(), () => false);
      await symlink(linked, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
    } else if (info.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
  }
  for (const folder of folders) await walk(join(staging, folder)).catch(error => { if (!missing(error)) throw error; });
}

async function saveReceipt(root: string, receipt: z.infer<typeof receiptSchema>) {
  const temporary = `${receiptPath(root)}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await rename(temporary, receiptPath(root)); }
  finally { await rm(temporary, { force: true }); }
}

async function verifyPreparedProject(target: string, receipt: z.infer<typeof receiptSchema>) {
  if (receipt.complete || receipt.published) return;
  for (const folder of folders) {
    const primary = join(receipt.source, folder);
    const original = await lstat(primary).then(() => primary, error => { if (missing(error)) return join(receipt.source, `${folder}.legalwork-migrated`); throw error; });
    if (await fingerprint(original) !== receipt.fingerprints[folder]
      || await fingerprint(join(target, folder)) !== (receipt.copiedFingerprints ?? receipt.fingerprints)[folder]) {
      throw new Error("Project support data diverged from its prepared migration copy. Both versions were preserved; resolve the conflict before retrying.");
    }
  }
}

/** Copy and verify two trees before registry cutover. Originals remain active
 * until native history moves, then become recovery snapshots. */
export async function prepareLocalProject(config: ServerConfig, workspace: WorkspaceInfo): Promise<WorkspaceInfo> {
  if (workspace.contentPath) return workspace;
  const source = await realpath(workspace.path);
  if (!(await stat(source)).isDirectory()) throw new Error("The project folder is unavailable.");
  const target = await canonicalFilePath(projectHome(config, workspace.id));
  if (resolve(target) === resolve(source)) {
    const recovered = await recoverLocalProject(config, workspace);
    if (recovered) return recovered;
    if (!await stat(join(source, "files")).then(info => info.isDirectory(), () => false)) throw new Error("The local project home has no saved document-folder association. Reconnect its original folder.");
    return { ...workspace, contentPath: join(source, "files") };
  }
  if (source === join(target, "files")) return { ...workspace, path: target, directory: target, contentPath: source };
  const suffix = relative(source, target);
  if (!suffix || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)) throw new Error("The local project home cannot be inside its connected content folder.");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  return withFileWriteLock(`${target}.migration.lock`, async () => {
    let receipt: z.infer<typeof receiptSchema> | undefined;
    try { receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath(target), "utf8"))); }
    catch (error) { if (!missing(error)) throw error; }
    if (receipt && (receipt.id !== workspace.id || receipt.source !== source)) throw new Error("The local project destination belongs to another migration.");
    if (receipt) {
      // A prepared copy is not the active project yet. Another installation or
      // the old app may have changed its source while this process was stopped.
      await verifyPreparedProject(target, receipt);
    }
    if (!receipt) {
      if (await lstat(target).then(() => true, error => { if (missing(error)) return false; throw error; })) throw new Error("The local project destination already exists without an ownership receipt.");
      const staging = `${target}.copy-${randomUUID()}`;
      await mkdir(staging, { mode: 0o700 });
      try {
        const fingerprints: Record<string, string> = {};
        for (const folder of folders) {
          const primary = join(source, folder);
          const original = await lstat(primary).then(() => primary, error => { if (missing(error)) return join(source, `${folder}.legalwork-migrated`); throw error; });
          const destination = join(staging, folder);
          const originalInfo = await lstat(original).catch(error => { if (missing(error)) return; throw error; });
          if (originalInfo?.isSymbolicLink()) throw new Error("A project support folder is linked. Preserve it and resolve the link before migrating.");
          const before = await fingerprint(original);
          if (before !== "missing") {
            await cp(original, destination, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
            if (await fingerprint(destination) !== before || await fingerprint(original) !== before) throw new Error("Project support data changed during migration. Retry after pending work finishes.");
          }
          fingerprints[folder] = before;
        }
        await relocateSupportLinks(staging, source, target);
        const copiedFingerprints = Object.fromEntries(await Promise.all(folders.map(async folder => [folder, await fingerprint(join(staging, folder))])));
        receipt = { version: 1, id: workspace.id, source, sourceAliases: [...new Set([source, resolve(workspace.path)])], fingerprints, copiedFingerprints, complete: false };
        await saveReceipt(staging, receipt);
        await rename(staging, target);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    return { ...workspace, path: target, directory: target, contentPath: source, previousPath: source };
  });
}

/** Restore durable root ownership without requiring the connected drive. */
export async function recoverLocalProject(config: Pick<ServerConfig, "projectsDirectory">, workspace: WorkspaceInfo): Promise<WorkspaceInfo | undefined> {
  const target = await canonicalFilePath(projectHome(config, workspace.id));
  let receipt: z.infer<typeof receiptSchema>;
  try { receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath(target), "utf8"))); }
  catch (error) { if (missing(error)) return; throw error; }
  if (receipt.id !== workspace.id || !isAbsolute(receipt.source) || resolve(receipt.source) === resolve(target)) throw new Error("The saved project home has invalid ownership metadata.");
  if (!receipt.complete && !receipt.published && resolve(workspace.path) !== resolve(target)) return;
  await verifyPreparedProject(target, receipt);
  return { ...workspace, path: target, directory: target, contentPath: receipt.source, previousPath: receipt.source };
}

/** Record the durable registry cutover before generated config can change the copy. */
export async function markLocalProjectPublished(workspace: WorkspaceInfo): Promise<void> {
  if (!workspace.contentPath || !workspace.previousPath) return;
  await withFileWriteLock(`${workspace.path}.migration.lock`, async () => {
    const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath(workspace.path), "utf8")));
    if (receipt.id !== workspace.id || receipt.source !== workspace.previousPath) throw new Error("Project migration ownership is invalid.");
    if (!receipt.published && !receipt.complete) await saveReceipt(workspace.path, { ...receipt, published: true });
  });
}

/** Owned registry updates are persisted by the startup caller after this batch. */
export async function prepareLocalProjects(config: ServerConfig): Promise<boolean> {
  if (config.readOnly) return false;
  let changed = false;
  for (let index = 0; index < config.workspaces.length; index++) {
    const workspace = config.workspaces[index];
    if (!workspace) continue;
    // Completed local projects must start without touching their connected
    // drive, including a source snapshot that could not be retired previously.
    if (workspace.contentPath) continue;
    try {
      const { retainDownloadedCopyOwnership } = await import("./project-sync-ownership.js");
      await retainDownloadedCopyOwnership(config, workspace);
      const local = await prepareLocalProject(config, workspace);
      const stored = await readLegalworkWorkspaceConfig(config, workspace.id);
      const native = stored.nativeEngineProject;
      if (native && typeof native === "object" && !Array.isArray(native) && "directory" in native && typeof native.directory === "string"
        && [workspace.path, local.previousPath].flatMap(root => root ? [projectPathKey(root)] : []).includes(projectPathKey(native.directory))) {
        let projection = "projection" in native ? native.projection : undefined;
        if (projection && typeof projection === "object" && "path" in projection && typeof projection.path === "string") {
          const suffix = relative(native.directory, projection.path);
          projection = suffix.startsWith(`.opencode${sep}`) ? { ...projection, path: join(local.path, suffix) } : undefined;
        }
        await writeLegalworkWorkspaceConfig(config, workspace.id, current => ({ ...current, nativeEngineProject: { ...native, directory: local.path, ...(projection ? { projection } : { projection: undefined }) } }));
      }
      config.workspaces[index] = local;
      config.authorizedRoots = [...new Set([...config.authorizedRoots, local.path])];
      changed = true;
    } catch (error) {
      console.warn(`[project-storage] ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return changed;
}

/** Receipts survive removal from the registry. Inspect only owned local
 * metadata, never probe other projects' disconnected document drives. */
export async function localProjectIdForContent(config: Pick<ServerConfig, "projectsDirectory">, content: string): Promise<string | undefined> {
  if (!config.projectsDirectory) return;
  const home = await canonicalFilePath(config.projectsDirectory), selected = await canonicalFilePath(content);
  const suffix = relative(home, selected).split(sep);
  if (suffix.length === 2 && suffix[1] === "files" && /^[a-zA-Z0-9_-]+$/.test(suffix[0])) return suffix[0];
  const entries = await readdir(home, { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error; });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    const path = join(home, entry.name);
    const raw = await readFile(receiptPath(path), "utf8").catch(error => { if (missing(error)) return; throw error; });
    if (!raw) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { continue; }
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== entry.name || !isAbsolute(parsed.data.source)) continue;
    if (projectPathKey(parsed.data.source) === projectPathKey(selected)) ids.push(entry.name);
  }
  if (ids.length > 1) throw new ApiError(409, "project_storage_identity_conflict", "More than one retained project home belongs to this folder. Open the intended local project home to preserve its identity.");
  return ids[0];
}

/** Called only after all native session locations were verified at the local home. */
export async function finishLocalProject(workspace: WorkspaceInfo): Promise<void> {
  if (!workspace.previousPath || !workspace.contentPath) return;
  await withFileWriteLock(`${workspace.path}.migration.lock`, async () => {
    const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath(workspace.path), "utf8")));
    if (receipt.complete && receipt.referencesComplete) return;
    if (receipt.id !== workspace.id || receipt.source !== workspace.previousPath) throw new Error("Project migration receipt does not match the registered project.");
    await saveReceipt(workspace.path, { ...receipt, published: true, complete: true, referencesComplete: true });
    await cleanupLocalProject(workspace).catch(error => console.warn(`[project-storage] Cleanup deferred for ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`));
  });
}

export async function localProjectMigrationPending(workspace: WorkspaceInfo): Promise<boolean> {
  if (!workspace.previousPath) return false;
  const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath(workspace.path), "utf8")));
  if (receipt.id !== workspace.id || receipt.source !== workspace.previousPath) throw new Error("Project migration ownership is invalid.");
  return !receipt.complete || !receipt.referencesComplete;
}

/** Incomplete placement is temporary, never evidence that a saved chat vanished. */
export async function projectChatMigrationPending(config: ServerConfig, workspace: WorkspaceInfo): Promise<boolean> {
  return Boolean(config.projectStorageMigrating || config.managedEngineStarting || config.projectsDirectory && !workspace.contentPath)
    || await localProjectMigrationPending(workspace);
}

/** Remember the registered spelling as well as realpath (for example a mapped
 * drive or symlink). Reading these aliases never needs the document drive. */
export async function localProjectReferenceRoots(workspace: WorkspaceInfo): Promise<WorkspaceInfo & { previousPaths?: string[] }> {
  if (!workspace.previousPath) return workspace;
  const raw = await readFile(receiptPath(workspace.path), "utf8").catch(error => { if (missing(error)) return; throw error; });
  if (!raw) return workspace;
  const receipt = receiptSchema.parse(JSON.parse(raw));
  if (receipt.id !== workspace.id || receipt.source !== workspace.previousPath) throw new Error("Project migration ownership is invalid.");
  return { ...workspace, previousPaths: receipt.sourceAliases ?? [receipt.source] };
}

/** Retire the original names only after native history moved. Keep a verified
 * local recovery copy; never delete a tree that changed since the cutover. */
async function cleanupLocalProject(workspace: WorkspaceInfo): Promise<void> {
  if (!workspace.previousPath) return;
  const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath(workspace.path), "utf8")));
  if (!receipt.complete || receipt.cleanupComplete) return;
  if (receipt.id !== workspace.id || receipt.source !== workspace.previousPath) throw new Error("Project migration ownership is invalid.");
  // An unavailable mount must never be mistaken for an empty project.
  await realpath(receipt.source);
  for (const folder of folders) {
    const original = join(receipt.source, folder);
    const retired = join(receipt.source, `${folder}.legalwork-migrated`);
    const expected = receipt.fingerprints[folder];
    const originalHash = await fingerprint(original), retiredHash = await fingerprint(retired);
    if (expected === "missing" && originalHash === "missing" && retiredHash === "missing") continue;
    if (originalHash !== "missing") {
      if (originalHash !== expected || retiredHash !== "missing") throw new Error("Original support data changed after migration; it was preserved for recovery.");
      await rename(original, retired);
    }
    if (await fingerprint(retired) === "missing") continue;
    if (await fingerprint(retired) !== expected) throw new Error("Retired support data changed; it was preserved.");
    const backup = join(workspace.path, ".project-storage-backup", folder);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    if (await fingerprint(backup) !== expected) {
      // A failed copy can be retried because it is private, unpublished recovery data.
      await rm(backup, { recursive: true, force: true });
      await cp(retired, backup, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    }
    if (await fingerprint(backup) !== expected || await fingerprint(retired) !== expected) throw new Error("Recovery verification failed; original support data was preserved.");
    // Another installation can still need this shared folder's pre-upgrade
    // snapshot. It is no longer an active engine directory; never delete it
    // merely because this installation completed its own migration.
  }
  await saveReceipt(workspace.path, { ...receipt, cleanupComplete: true });
}

export { projectFilePermissionRules, primaryContentFolderRules } from "./project-storage-permissions.js";
