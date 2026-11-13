import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isLauncherInternalPath, type LauncherResultReference, type LauncherSearchResult } from "@legalwork/types/launcher";

/** Resolve again at the user action, including links and deleted files. Never trust an index path as a native path. */
export async function canonicalResultFile(root: string, relativePath: string, directory: boolean) {
  if (!path.isAbsolute(root) || path.isAbsolute(relativePath) || relativePath.includes("\0")
    || relativePath.split(/[\\/]/).includes("..") || isLauncherInternalPath(relativePath)) throw new Error("The file is outside its source folder.");
  const base = await realpath(root);
  const file = await realpath(path.resolve(base, relativePath));
  if (file !== base && !file.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) throw new Error("The file is outside its source folder.");
  const info = await stat(file);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("This file or folder is no longer available.");
  return file;
}

export function resultReference(item: LauncherSearchResult): LauncherResultReference {
  return { kind: item.kind, id: item.id, workspaceId: item.workspaceId, sourceId: item.sourceId,
    ...(item.folderId ? { folderId: item.folderId } : {}), ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.kind === "files" && item.path !== undefined ? { path: item.path } : {}), ...(item.fileType === "folder" ? { fileType: "folder" } : {}) };
}
