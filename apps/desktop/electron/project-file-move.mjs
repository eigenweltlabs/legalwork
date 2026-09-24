import { constants } from "node:fs";
import { copyFile, link, lstat, realpath, unlink, utimes } from "node:fs/promises";
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

/** Move regular files into a registered project's root without replacing files.
 * Hard links provide an exclusive, fast move on the same volume. Other volumes
 * use an exclusive copy; the source is removed only after that copy succeeds.
 * @param {string} workspacePath
 * @param {string[]} sources
 * @param {typeof link} [linkFile]
 * @returns {Promise<import("@legalwork/types/desktop-ipc").WorkspaceMoveFilesResult>}
 */
export async function moveFilesIntoProject(workspacePath, sources, linkFile = link) {
  const root = await realpath(workspacePath);
  if (!(await lstat(root)).isDirectory()) throw new Error("Project folder is unavailable");
  if (!Array.isArray(sources) || !sources.length || sources.some((source) => typeof source !== "string" || !path.isAbsolute(source))) {
    throw new Error("Native file paths are required");
  }
  /** @type {import("@legalwork/types/desktop-ipc").WorkspaceMoveFilesResult} */
  const result = { files: [] };
  for (const source of new Set(sources)) {
    const name = path.basename(source);
    try {
      const original = await lstat(source);
      if (!original.isFile()) {
        result.files.push({ name, status: "failed", error: "file_only" });
        continue;
      }
      if (await realpath(path.dirname(source)) === root) {
        result.files.push({ name, path: name, status: "already_here" });
        continue;
      }
      const extension = path.extname(name);
      const stem = name.slice(0, name.length - extension.length);
      let completed = false;
      for (let suffix = 1; suffix <= 10000; suffix += 1) {
        const destinationName = suffix === 1 ? name : `${stem} (${suffix})${extension}`;
        const destination = path.join(root, destinationName);
        let copied = false;
        try {
          try {
            await linkFile(source, destination);
          } catch (error) {
            if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) throw error;
            await copyFile(source, destination, constants.COPYFILE_EXCL);
            copied = true;
          }
        } catch (error) {
          if (error.code === "EEXIST") continue;
          throw error;
        }
        try {
          const target = await lstat(destination);
          const current = await lstat(source).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          });
          if (!target.isFile() || (!copied && (target.dev !== original.dev || target.ino !== original.ino)) || current && (current.dev !== original.dev || current.ino !== original.ino ||
              (copied && (current.size !== original.size || current.mtimeMs !== original.mtimeMs || target.size !== original.size)))) {
            await unlink(destination);
            result.files.push({ name, status: "failed", error: "changed" });
            completed = true;
            break;
          }
          if (copied) await utimes(destination, original.atime, original.mtime);
          if (current) await unlink(source).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        } catch (error) {
          // A failed move keeps its source. Remove only our new destination.
          await unlink(destination).catch(() => {});
          throw error;
        }
        result.files.push({ name, path: destinationName, status: "moved" });
        completed = true;
        break;
      }
      if (!completed) result.files.push({ name, status: "failed", error: "failed" });
    } catch (error) {
      result.files.push({ name, status: "failed", error: error.code === "ENOENT" ? "unavailable" : "failed" });
    }
  }
  return result;
}
