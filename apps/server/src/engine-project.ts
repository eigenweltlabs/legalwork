import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { EngineProjectStatus } from "@legalwork/types/engine-project";
import type { NativeConfig } from "./native-opencode-config.js";
import { ApiError } from "./errors.js";
import { canonicalFilePath, withFileWriteLock } from "./file-write-lock.js";
import { readLegalworkWorkspaceConfig, writeLegalworkWorkspaceConfig } from "./legalwork-workspace-config-store.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import { engineStorageDir } from "./engine-storage.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { approvedNativePluginIdentities, approveNativePluginTargets, discoverProjectPluginTargets } from "./native-project-plugins.js";

const recordSchema = z.object({
  version: z.literal(1), directory: z.string(),
  approval: z.object({ approvedAt: z.number(), ancestors: z.array(z.string()) }).optional(),
  projection: z.object({ path: z.string(), digest: z.string() }).optional(),
});
type ProjectRecord = z.infer<typeof recordSchema>;
const key = "nativeEngineProject";
const names = ["opencode.json", "opencode.jsonc"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const rootFor = (workspace: WorkspaceInfo) => canonicalFilePath(workspace.directory?.trim() || workspace.path);
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

async function readRecord(config: ServerConfig, workspace: WorkspaceInfo, directory: string): Promise<ProjectRecord> {
  const parsed = recordSchema.safeParse((await readLegalworkWorkspaceConfig(config, workspace.id))[key]);
  return parsed.success && parsed.data.directory === directory ? parsed.data : { version: 1, directory };
}
async function updateRecord(config: ServerConfig, workspace: WorkspaceInfo, directory: string, update: (record: ProjectRecord) => ProjectRecord) {
  return withProjectLock(config, workspace, async () => {
    const record = await readRecord(config, workspace, directory);
    await writeRecord(config, workspace, update(record));
  });
}
async function withProjectLock<T>(config: ServerConfig, workspace: WorkspaceInfo, action: () => Promise<T>): Promise<T> {
  const lock = join(runtimeStorageDir(config), `native-project-${digest(workspace.id)}.lock`);
  return withFileWriteLock(lock, action);
}
async function writeRecord(config: ServerConfig, workspace: WorkspaceInfo, record: ProjectRecord) {
  await writeLegalworkWorkspaceConfig(config, workspace.id, current => ({ ...current, [key]: record }));
}

async function approvalScope(directory: string) {
  const result: EngineProjectStatus["approvalScope"] = [];
  let current = directory;
  while (true) {
    const candidates = [...names.map(name => join(current, name)), ...names.map(name => join(current, ".opencode", name)),
      join(current, ".opencode", "plugin"), join(current, ".opencode", "plugins")];
    const configPaths: string[] = [];
    for (const path of candidates) {
      try { await lstat(path); configPaths.push(path); }
      catch (error) { if (!missing(error)) throw error; }
    }
    // Include every potential ancestor scope, even if it has no config yet:
    // approval covers later changes, rather than promising racy hash revocation.
    result.push({ directory: current, configPaths });
    const parent = dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

async function projectionStatus(record: ProjectRecord, managed = false): Promise<EngineProjectStatus["projection"]> {
  try { if (!(await lstat(record.directory)).isDirectory()) return { diagnostic: "This project folder is unavailable. Reconnect its existing folder before starting OpenCode automation." }; }
  catch (error) { if (missing(error)) return { diagnostic: "This project folder is unavailable. Reconnect its existing folder before starting OpenCode automation." }; throw error; }
  if (managed) return {};
  if (!record.projection) {
    const candidates = [...names.map(name => join(record.directory, name)), ...names.map(name => join(record.directory, ".opencode", name))];
    const occupied = await Promise.all(candidates.map(path => lstat(path).then(() => true, error => { if (missing(error)) return false; throw error; })));
    return occupied.every(Boolean) ? { diagnostic: "All native OpenCode config file names are already authored. Preserve those files and free one of opencode.json, opencode.jsonc, .opencode/opencode.json or .opencode/opencode.jsonc for LegalWork's generated selection document." } : {};
  }
  try {
    if (digest(await readFile(record.projection.path, "utf8")) !== record.projection.digest) {
      return { path: record.projection.path, diagnostic: "The LegalWork-generated OpenCode file was changed outside LegalWork. Preserve your edits by moving them into another native OpenCode config file, then remove this generated file and retry." };
    }
    return { path: record.projection.path };
  } catch (error) { if (missing(error)) return {}; throw error; }
}

async function ownedProjectionPaths(config: ServerConfig) {
  const paths: string[] = [];
  for (const workspace of config.workspaces) {
    const record = await readRecord(config, workspace, await rootFor(workspace));
    if (record.projection) paths.push(record.projection.path);
  }
  return paths;
}

export async function engineProjectStatus(config: ServerConfig, workspace: WorkspaceInfo): Promise<EngineProjectStatus> {
  const directory = await rootFor(workspace);
  const managed = config.engineConfigurationMode === "managed";
  // A generated document and its private ownership receipt are one logical
  // publication. Admission must not compare the new file with the old receipt.
  const { record, projection: snapshotProjection } = await withProjectLock(config, workspace, async () => {
    const record = await readRecord(config, workspace, directory);
    return { record, projection: await projectionStatus(record, managed) };
  });
  const scope = await approvalScope(directory);
  let projection = snapshotProjection;
  const approved = record.approval && scope.every((item, index) => record.approval?.ancestors[index] === item.directory)
    && scope.length === record.approval.ancestors.length;
  // App registrations authorize managed capabilities. Authored folder files
  // remain untouched and inactive; they cannot demand an executable approval.
  const required = !managed && config.engineProjectTrustRequired === true;
  const identities = new Set(await approvedNativePluginIdentities(config));
  let plugins: EngineProjectStatus["plugins"] = [];
  try { if (!managed) plugins = (await discoverProjectPluginTargets(directory, await ownedProjectionPaths(config), Boolean(approved))).map(item => ({
    target: item.target, sources: item.sources, approved: identities.has(item.identity),
  })); }
  catch (error) { if (error instanceof ApiError && error.code === "project_engine_configuration_conflict") projection = { ...projection, diagnostic: error.message }; else throw error; }
  const recoveryState = config.managedEngineRecoveryState?.();
  let recovery: EngineProjectStatus["recovery"];
  if (recoveryState) {
    const own = await Promise.all(recoveryState.heldSessions.map(async session =>
      await canonicalFilePath(session.directory).catch(() => "") === directory ? session.id : undefined));
    const heldSessionIds = [...new Set(own.filter(id => id !== undefined))];
    recovery = { mode: recoveryState.mode, heldSessionIds, waitingForOtherProjects: own.some(id => id === undefined),
      // Global preflight diagnostics can contain another project's path.
      ...(recoveryState.error ? { error: { code: "engine_recovery_pending", message: "Interrupted work remains paused. Review pending project approvals and unfinished Undo, then retry recovery." } } : {}) };
  }
  return { state: projection.diagnostic ? "configuration_conflict" : required && (!approved || plugins.some(item => !item.approved)) ? "approval_required" : "ready",
    required, directory, ...(approved ? { approvedAt: record.approval?.approvedAt } : {}), approvalScope: scope, projection, plugins, ...(recovery ? { recovery } : {}) };
}

export async function approveEngineProject(config: ServerConfig, workspace: WorkspaceInfo, selectedDirectory: string, selectedTargets: string[]): Promise<EngineProjectStatus> {
  const directory = await rootFor(workspace);
  if (selectedDirectory !== directory) throw new ApiError(409, "project_directory_changed", "The project folder changed. Review its automation scope again before approving.");
  const status = await engineProjectStatus(config, workspace);
  if (selectedTargets.some(target => !status.plugins.some(item => item.target === target)) || status.plugins.some(item => !item.approved && !selectedTargets.includes(item.target))) {
    throw new ApiError(409, "project_plugin_approval_changed", "The project's executable plugin selections changed. Review its current plugin list before approving.", status);
  }
  const scope = await approvalScope(directory);
  // Resolving a configured file/env reference can read private material. Only
  // do so after the person explicitly approved this folder's configuration;
  // keep the literal reference as its public review label.
  const resolved = await discoverProjectPluginTargets(directory, await ownedProjectionPaths(config), true);
  await approveNativePluginTargets(config, resolved.filter(item => selectedTargets.includes(item.target)).map(item => item.identity));
  await updateRecord(config, workspace, directory, current => ({ ...current, approval: { approvedAt: Date.now(), ancestors: scope.map(item => item.directory) } }));
  return engineProjectStatus(config, workspace);
}

export function nativeEngineProjectRegistryPath(config: ServerConfig) {
  return join(engineStorageDir(config), "native-project-approvals.json");
}

export async function writeNativeEngineProjectRegistry(config: ServerConfig): Promise<void> {
  const projects = await Promise.all(config.workspaces.map(async workspace => {
    const status = await engineProjectStatus(config, workspace);
    return { directory: status.directory, approved: status.state === "ready" && (config.engineConfigurationMode === "managed" || Boolean(status.approvedAt)) };
  }));
  const path = nativeEngineProjectRegistryPath(config), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(temporary, JSON.stringify({ version: 1, projects }), { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function assertEngineProjectReady(config: ServerConfig, workspace: WorkspaceInfo): Promise<void> {
  if (!config.engineProjectTrustRequired) return;
  const status = await engineProjectStatus(config, workspace);
  if (status.state === "approval_required") throw new ApiError(409, "project_automation_approval_required",
    "Review and approve this project's OpenCode configuration and automation before starting its agent. Approval covers later changes in this folder and the listed parent configuration folders.", status);
  if (status.state === "configuration_conflict") throw new ApiError(409, "project_engine_configuration_conflict", status.projection.diagnostic ?? "The generated OpenCode configuration conflicts with an authored file.", status);
}

/** Retire only byte-unchanged files owned by an existing private receipt.
 * Preserve the entire document and receipt privately before removing clutter
 * from a case folder. Edited/authored files and symlinked paths stay intact. */
export async function archiveNativeProjectProjection(config: ServerConfig, workspace: WorkspaceInfo): Promise<void> {
  const directory = await rootFor(workspace);
  await withProjectLock(config, workspace, async () => {
    const record = await readRecord(config, workspace, directory);
    const projection = record.projection;
    if (!projection || !isAbsolute(projection.path)) return;
    const candidates = [...names.map(name => join(directory, name)), ...names.map(name => join(directory, ".opencode", name))];
    if (!candidates.includes(projection.path)) return;
    if (dirname(projection.path) !== directory) {
      const parent = await lstat(dirname(projection.path)).catch(error => { if (missing(error)) return undefined; throw error; });
      if (!parent?.isDirectory() || parent.isSymbolicLink()) return;
    }
    await withFileWriteLock(projection.path, async () => {
      const before = await lstat(projection.path).catch(error => { if (missing(error)) return undefined; throw error; });
      if (!before?.isFile() || before.isSymbolicLink() || await realpath(projection.path) !== projection.path) return;
      const content = await readFile(projection.path);
      if (digest(content.toString("utf8")) !== projection.digest) return;
      const archive = join(runtimeStorageDir(config), "native-project-projection-archive", digest(workspace.id));
      await mkdir(archive, { recursive: true, mode: 0o700 });
      const document = join(archive, `${projection.digest}.jsonc`), receipt = join(archive, `${projection.digest}.receipt.json`);
      const preserve = async (path: string, value: Buffer | string) => {
        try { await writeFile(path, value, { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          if (!(await readFile(path)).equals(Buffer.from(value))) throw new Error("The private project configuration archive was changed. The original file was preserved.");
        }
      };
      await preserve(document, content);
      await preserve(receipt, JSON.stringify({ workspaceId: workspace.id, record }));
      const after = await lstat(projection.path);
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
        || !(await readFile(projection.path)).equals(content)) return;
      await rm(projection.path);
      const { projection: retired, ...retained } = record;
      await writeRecord(config, workspace, retained);
    });
  });
}

/** A native document contains only selection structure and private string
 * references. Definitions and secrets remain in the single private library. */
export async function writeNativeProjectProjection(config: ServerConfig, workspace: WorkspaceInfo, configuration: NativeConfig): Promise<string> {
  const directory = await rootFor(workspace);
  try { if (!(await lstat(directory)).isDirectory()) throw new Error("not_directory"); }
  catch { throw new ApiError(409, "project_engine_configuration_conflict", "This project folder is unavailable. Reconnect its existing folder before starting OpenCode automation."); }
  const privateDirectory = join(runtimeStorageDir(config), "native-config-strings");
  if (privateDirectory.includes("}")) throw new ApiError(409, "native_config_reference_path", "The private LegalWork configuration path contains a closing brace, which OpenCode file references cannot represent. Choose another LegalWork data folder.");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const published = new Map<string, Promise<void>>();
  const reference = async (value: unknown): Promise<unknown> => {
    if (typeof value === "string") {
      const variables = [...value.matchAll(/\{(?:env|file):[^}]+\}/g)];
      if (variables.length) {
        let result = "", cursor = 0;
        for (const variable of variables) {
          result += await reference(value.slice(cursor, variable.index));
          if (variable[0].startsWith("{file:")) {
            const name = variable[0].slice(6, -1);
            const path = name.startsWith("~/") ? join(homedir(), name.slice(2)) : isAbsolute(name) ? name : resolve(runtimeStorageDir(config), name);
            result += `{file:${path}}`;
          } else result += variable[0];
          cursor = variable.index + variable[0].length;
        }
        return result + await reference(value.slice(cursor));
      }
      const leading = value.match(/^\s*/)?.[0] ?? "";
      const remaining = value.slice(leading.length);
      const trailing = remaining.match(/\s*$/)?.[0] ?? "";
      const content = remaining.slice(0, remaining.length - trailing.length);
      const path = join(privateDirectory, `${digest(content)}.txt`);
      let publishing = published.get(path);
      if (!publishing) {
        publishing = (async () => {
          const temporary = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, content, { mode: 0o600 });
            try { await link(temporary, path); }
            catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
              if (await readFile(path, "utf8") !== content) throw new ApiError(409, "native_config_library_changed", "A private shared configuration value was changed outside LegalWork. Restore the private library before running the engine.");
            }
          } finally { await rm(temporary, { force: true }); }
        })();
        published.set(path, publishing);
      }
      await publishing;
      return `${leading}{file:${path}}${trailing}`;
    }
    if (Array.isArray(value)) return Promise.all(value.map(reference));
    if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, item]) => [name, await reference(item)])));
    return value;
  };
  const content = `// Generated by LegalWork. Definitions are kept in its private shared library.\n${JSON.stringify(await reference(configuration), null, 2)}\n`;
  return withProjectLock(config, workspace, async () => {
  const record = await readRecord(config, workspace, directory);
  const candidates = record.projection ? [record.projection.path] : [
    ...names.map(name => join(directory, name)), ...names.map(name => join(directory, ".opencode", name)),
  ];
  for (const path of candidates) {
    const written = await withFileWriteLock(path, async () => {
      let current: string | undefined;
      try { current = await readFile(path, "utf8"); }
      catch (error) { if (!missing(error)) throw error; }
      if (current !== undefined && (record.projection?.path !== path || digest(current) !== record.projection.digest)) return false;
      if (current !== content) {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, { mode: 0o600 });
          if (current === undefined) {
            try { await link(temporary, path); }
            catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return false; throw error; }
          } else await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
      }
      await writeRecord(config, workspace, { ...record, projection: { path, digest: digest(content) } });
      return true;
    });
    if (written) return path;
  }
  throw new ApiError(409, "project_engine_configuration_conflict", record.projection
    ? "The LegalWork-generated OpenCode file contains edits. Preserve them in an authored config file, remove the generated file and retry."
    : "All native OpenCode config file names are already authored. Keep those files intact and free one of opencode.json, opencode.jsonc, .opencode/opencode.json or .opencode/opencode.jsonc for LegalWork's generated selection document.",
  { directory, paths: candidates });
  });
}
