import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { withFileWriteLock } from "./file-write-lock.js";
import type { WorkspaceInfo } from "./types.js";

const names = ["opencode.json", "opencode.jsonc"];
const snapshotSchema = z.object({ digest: z.string().nullable(), previous: z.string().optional() });
const manifestSchema = z.object({ source: z.string(), files: z.record(z.string(), snapshotSchema) });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const conflict = () => new ApiError(409, "project_engine_configuration_conflict", "A local OpenCode configuration snapshot was changed outside LegalWork. Preserve those edits and resolve the configuration conflict before retrying.");

/** Configuration references retain their original content base. Moved support
 * references follow their existing suffix into the local home. */
export function connectedConfigurationPath(workspace: { path: string; contentPath?: string | null }, value: string): string {
  if (value.startsWith("file://")) return pathToFileURL(connectedConfigurationPath(workspace, fileURLToPath(value))).href;
  if (value.startsWith("~/") || /^[a-z]+:\/\//i.test(value) || value.includes("{env:")) return value;
  const content = workspace.contentPath || workspace.path;
  const suffix = relative(content, resolve(content, value));
  if (/^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix)) return resolve(workspace.path, suffix);
  return isAbsolute(value) ? value : resolve(content, suffix);
}

export function connectedMcpServer(workspace: { path: string; contentPath?: string | null }, server: { command: readonly string[]; cwd?: string }, defaultContent = true) {
  return {
    ...(server.cwd || defaultContent ? { cwd: connectedConfigurationPath(workspace, server.cwd || ".") } : {}),
    command: server.command.map(value => isAbsolute(value) || /^(?:\.\/)?\.(?:opencode|legalwork)(?:[\\/]|$)/.test(value) ? connectedConfigurationPath(workspace, value) : value),
  };
}

function document(workspace: WorkspaceInfo, raw: string): string {
  const errors: ParseError[] = [];
  const input: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length || !input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(409, "project_engine_configuration_conflict", "The connected folder's OpenCode configuration is invalid. Correct its JSON/JSONC before retrying.");
  const reference = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/\{file:([^}]+)\}/g, (_, path: string) => `{file:${connectedConfigurationPath(workspace, path)}}`);
    if (Array.isArray(value)) return value.map(reference);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reference(item)]));
    return value;
  };
  const result = Object.fromEntries(Object.entries(input).map(([key, item]) => [key, reference(item)]));
  for (const key of ["instructions", "skills"]) {
    const values = result[key];
    if (Array.isArray(values)) result[key] = values.map(value => typeof value === "string" ? connectedConfigurationPath(workspace, value) : value);
  }
  const plugin = (value: unknown): unknown => {
    const target = (name: string) => isAbsolute(name) || name.startsWith("file://") || name.startsWith("./") || name.startsWith("../") ? connectedConfigurationPath(workspace, name) : name;
    if (typeof value === "string") return target(value);
    if (Array.isArray(value)) return value.map((item, index) => index === 0 && typeof item === "string" ? target(item) : item);
    if (value && typeof value === "object" && "package" in value && typeof value.package === "string") return { ...value, package: target(value.package) };
    return value;
  };
  for (const key of ["plugins", "plugin"]) if (Array.isArray(result[key])) result[key] = result[key].map(plugin);
  if (result.mcp && typeof result.mcp === "object" && !Array.isArray(result.mcp)) {
    const mcp = Object.fromEntries(Object.entries(result.mcp));
    const servers = mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers) ? Object.fromEntries(Object.entries(mcp.servers)) : mcp;
    const nested = servers !== mcp;
    const mapped = Object.fromEntries(Object.entries(servers).map(([name, value]) => {
      const parsed = z.object({ command: z.array(z.string()), cwd: z.string().optional() }).passthrough().safeParse(value);
      return [name, parsed.success ? { ...parsed.data, ...connectedMcpServer(workspace, parsed.data) } : value];
    }));
    result.mcp = nested ? { ...mcp, servers: mapped } : mapped;
  }
  return `// LegalWork snapshot of ${JSON.stringify(workspace.contentPath)}; edit the original configuration there.\n${JSON.stringify(result, null, 2)}\n`;
}

/** Native project-root documents load below .opencode, just as before. Owned
 * local snapshots keep startup independent from an unavailable content drive.
 * Refreshes are explicit or driven by the post-startup content watcher. */
export async function prepareConnectedConfiguration(workspace: WorkspaceInfo, refresh = false): Promise<void> {
  if (!workspace.contentPath || resolve(workspace.path) === resolve(workspace.contentPath)) return;
  const contentPath = workspace.contentPath;
  const manifestPath = join(workspace.path, ".opencode", "legalwork", "connected-config.json");
  await withFileWriteLock(manifestPath, async () => {
    const atomicWrite = async (path: string, content: string) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    };
    const cachePath = (hash: string) => join(dirname(manifestPath), "connected-config-cache", `${hash}.jsonc`);
    const materialize = async (manifest: z.infer<typeof manifestSchema>) => {
      for (const [name, snapshot] of Object.entries(manifest.files)) {
        if (!names.includes(name)) throw conflict();
        const target = join(workspace.path, name);
        const current = await readFile(target, "utf8").catch(error => { if (missing(error)) return; throw error; });
        if (current !== undefined && ![snapshot.digest, snapshot.previous].includes(digest(current))) throw conflict();
        if (snapshot.digest === null) { if (current !== undefined) await rm(target); continue; }
        if (current !== undefined && digest(current) === snapshot.digest) continue;
        if (!/^[a-f0-9]{64}$/.test(snapshot.digest)) throw conflict();
        const content = await readFile(cachePath(snapshot.digest), "utf8");
        if (digest(content) !== snapshot.digest) throw conflict();
        await atomicWrite(target, content);
      }
      const complete = { source: manifest.source, files: Object.fromEntries(Object.entries(manifest.files).flatMap(([name, snapshot]) => snapshot.digest === null ? [] : [[name, { digest: snapshot.digest }]])) };
      if (JSON.stringify(complete) !== JSON.stringify(manifest)) await atomicWrite(manifestPath, JSON.stringify(complete));
      return complete;
    };
    let manifest: z.infer<typeof manifestSchema> | undefined;
    try { manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))); }
    catch (error) { if (!missing(error)) throw error; }
    if (manifest && manifest.source !== contentPath) throw conflict();
    if (manifest) {
      manifest = await materialize(manifest);
      if (!refresh) return;
    }
    if (!await stat(contentPath).then(info => info.isDirectory(), () => false)) return;
    const files: z.infer<typeof manifestSchema>["files"] = {};
    for (const name of names) {
      const target = join(workspace.path, name);
      const current = await readFile(target, "utf8").catch(error => { if (missing(error)) return; throw error; });
      const previous = manifest?.files[name];
      const source = await readFile(join(contentPath, name), "utf8").catch(error => {
        if (missing(error)) return;
        throw new ApiError(409, "project_engine_configuration_conflict", "The connected folder's OpenCode configuration is unavailable. Its last local snapshot was preserved; reconnect the folder before refreshing.");
      });
      if (source === undefined && !previous) continue;
      if (current !== undefined && (!previous || digest(current) !== previous.digest)) throw conflict();
      if (source === undefined) { files[name] = { digest: null, ...(previous?.digest ? { previous: previous.digest } : {}) }; continue; }
      const content = document(workspace, source);
      const hash = digest(content);
      files[name] = { digest: hash, ...(previous?.digest ? { previous: previous.digest } : {}) };
      await atomicWrite(cachePath(hash), content);
    }
    // Publish ownership and all desired local bytes before replacing any native
    // document. A restart completes this publication without the source drive.
    const next = { source: contentPath, files };
    await atomicWrite(manifestPath, JSON.stringify(next));
    await materialize(next);
  });
}

export function watchConnectedConfiguration(workspace: WorkspaceInfo, changed: () => Promise<void>, warn: (error: unknown) => void): () => void {
  if (!workspace.contentPath) return () => {};
  let watcher: FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  let pending = Promise.resolve();
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      pending = pending.then(async () => { if (!closed) { await prepareConnectedConfiguration(workspace, true); await changed(); } }).catch(warn);
    }, 500);
    timer.unref();
  };
  try {
    watcher = watch(workspace.contentPath, { persistent: false, recursive: process.platform !== "linux" }, (_event, filename) => {
      const path = filename?.toString().replaceAll("\\", "/") || "";
      if (!path || /^(?:opencode\.jsonc?|AGENTS\.md|Skills(?:\/|$)|\.claude(?:\/|$)|\.agents(?:\/|$))/.test(path)) schedule();
    });
    // Reconnect/restart catches edits made while no watcher was running.
    schedule();
  } catch (error) { warn(error); }
  return () => { closed = true; if (timer) clearTimeout(timer); watcher?.close(); };
}
