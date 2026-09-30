import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, unlink, utimes } from "node:fs/promises";
import path from "node:path";

/** Resolve only registered local projects, including projects created by the
 * server after desktop startup. Never accept a destination path from renderer.
 * @param {string} workspaceId
 * @param {import("@legalwork/types/workspace").WorkspaceWire[]} desktopWorkspaces
 * @param {Pick<import("@legalwork/types/desktop-ipc").LegalworkServerInfo, "running" | "baseUrl" | "ownerToken" | "clientToken">} server
 */
export async function resolveProjectFolder(workspaceId, desktopWorkspaces, server) {
  const desktop = desktopWorkspaces.find((entry) => entry.id === workspaceId);
  if (desktop) {
    if (desktop.workspaceType !== "remote" && desktop.path) return desktop.path;
    throw new Error("Local project not found");
  }
  const token = server.ownerToken || server.clientToken;
  if (!server.running || !server.baseUrl || !token) throw new Error("Local project not found");
  const response = await fetch(`${server.baseUrl.replace(/\/+$/, "")}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Local project lookup failed");
  const list = await response.json();
  const workspace = Array.isArray(list.items)
    ? list.items.find((entry) => entry?.id === workspaceId && entry.workspaceType === "local")
    : null;
  if (typeof workspace?.path !== "string" || !path.isAbsolute(workspace.path)) throw new Error("Local project not found");
  return workspace.path;
}

/** Copy files and folders recursively into a registered project without replacing existing files.
 * Copies have independent contents; the original is never modified or removed.
 * @param {string} workspacePath
 * @param {string[]} sources
 * @param {typeof copyFile} [copy]
 * @param {string} [folder]
 * @returns {Promise<import("@legalwork/types/desktop-ipc").WorkspaceCopyFilesResult>}
 */
export async function copyFilesIntoProject(workspacePath, sources, copy = copyFile, folder = "") {
  const project = await realpath(workspacePath);
  if (typeof folder !== "string" || path.isAbsolute(folder) || folder.split(/[/\\]/).includes("..")) throw new Error("Invalid project folder");
  const root = await realpath(path.join(project, folder));
  const relative = path.relative(project, root);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Invalid project folder");
  if (!(await lstat(root)).isDirectory()) throw new Error("Project folder is unavailable");
  if (!Array.isArray(sources) || !sources.length || sources.some((source) => typeof source !== "string" || !path.isAbsolute(source))) {
    throw new Error("Native file paths are required");
  }
  /** @type {import("@legalwork/types/desktop-ipc").WorkspaceCopyFilesResult} */
  const result = { files: [] };
  async function copyEntry(source, parent, relativeParent, name = path.basename(source)) {
    const basename = path.basename(source);
    try {
      const original = await lstat(source);
      if (!original.isFile() && !original.isDirectory()) {
        result.files.push({ name, status: "failed", error: "file_only" });
        return;
      }
      if (await realpath(path.dirname(source)) === parent) {
        result.files.push({ name, path: path.join(relativeParent, basename), status: "already_here" });
        return;
      }
      if (original.isDirectory()) {
        const descendant = path.relative(await realpath(source), parent);
        if (!descendant || (!path.isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${path.sep}`))) {
          result.files.push({ name, status: "failed", error: "recursive" });
          return;
        }
      }
      const extension = original.isFile() ? path.extname(basename) : "";
      const stem = basename.slice(0, basename.length - extension.length);
      let completed = false;
      for (let suffix = 1; suffix <= 10000; suffix += 1) {
        const destinationName = suffix === 1 ? basename : `${stem} (${suffix})${extension}`;
        const destination = path.join(parent, destinationName);
        const destinationPath = path.join(relativeParent, destinationName);
        try {
          if (original.isDirectory()) await mkdir(destination);
          else await copy(source, destination, constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code === "EEXIST") continue;
          throw error;
        }
        if (original.isDirectory()) {
          // Reserve a new folder before traversing; never merge into or overwrite an existing one.
          result.files.push({ name, path: destinationPath, status: "copied" });
          for (const child of await readdir(source)) {
            await copyEntry(path.join(source, child), destination, destinationPath, path.join(name, child));
          }
          await utimes(destination, original.atime, original.mtime);
          return;
        }
        try {
          const target = await lstat(destination);
          const current = await lstat(source).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          });
          if (!target.isFile() || !current || current.dev !== original.dev || current.ino !== original.ino ||
              current.size !== original.size || current.mtimeMs !== original.mtimeMs || target.size !== original.size) {
            await unlink(destination);
            result.files.push({ name, status: "failed", error: "changed" });
            completed = true;
            break;
          }
          await utimes(destination, original.atime, original.mtime);
        } catch (error) {
          // A failed copy keeps its source. Remove only our new destination.
          await unlink(destination).catch(() => {});
          throw error;
        }
        result.files.push({ name, path: destinationPath, status: "copied" });
        completed = true;
        break;
      }
      if (!completed) result.files.push({ name, status: "failed", error: "failed" });
    } catch (error) {
      result.files.push({ name, status: "failed", error: error.code === "ENOENT" ? "unavailable" : "failed" });
    }
  }
  for (const source of new Set(sources)) await copyEntry(source, root, folder);
  return result;
}
