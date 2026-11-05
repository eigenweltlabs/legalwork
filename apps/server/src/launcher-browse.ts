import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { isLauncherInternalPath, type LauncherSearchResult } from "@legalwork/types/launcher";
import { ApiError } from "./errors.js";

/** Read one directory, with the same root boundary as file opening. Never follow listed symlinks. */
export async function browseLauncherDirectory(input: { root: string; path: string; workspaceId: string | null; folderId?: string; sourceKind?: LauncherSearchResult["sourceKind"]; name: string }) {
  if (isAbsolute(input.path) || input.path.split(/[\\/]/).includes("..") || input.path && isLauncherInternalPath(input.path)) throw new ApiError(400, "invalid_path", "Choose a folder inside this project.");
  const root = await realpath(input.root);
  const directory = await realpath(resolve(root, input.path));
  if (directory !== root && !directory.startsWith(root.endsWith(sep) ? root : root + sep)) throw new ApiError(400, "invalid_path", "The folder is outside this project.");
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()) && !isLauncherInternalPath(entry.name) && !["node_modules", "vendor", "dist", "build", "coverage", "__pycache__"].includes(entry.name));
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const items: LauncherSearchResult[] = [];
  for (const entry of entries.slice(0, 2000)) {
    const path = [input.path, entry.name].filter(Boolean).join("/");
    const info = await stat(resolve(directory, entry.name)).catch(() => null);
    if (!info) continue;
    items.push({ id: path, kind: "files", workspaceId: input.workspaceId, folderId: input.folderId, sourceId: input.folderId ? `folder:${input.folderId}` : `local:${input.workspaceId}`,
      title: entry.name, subtitle: input.name, sourceKind: input.sourceKind, path, updatedAt: info.mtimeMs, size: info.size, fileType: entry.isDirectory() ? "folder" : extname(entry.name).slice(1).toLowerCase(), match: "recent", score: 0, actions: entry.isDirectory() ? ["open"] : ["open", "chat-with-assistant", "summarize"] });
  }
  return { items, truncated: entries.length > 2000 };
}
