import { isLauncherInternalPath } from "./native-shared-values.js";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { LauncherSearchResult } from "@legalwork/types/launcher";

/** Like the main file browser, verify the current filesystem, not cached index
 * or recent-use metadata. This never repairs or changes deletion state. */
export async function existingLauncherFiles(rootPath: string, items: LauncherSearchResult[]) {
  const root = await realpath(rootPath).catch(() => null);
  if (!root || !(await stat(root).catch(() => null))?.isDirectory()) return [];
  const visible = await Promise.all(items.map(async item => {
    const path = item.path ?? item.id;
    if (item.kind !== "files" || isAbsolute(path) || isLauncherInternalPath(path) || path.split(/[\\/]/).includes("..")) return false;
    if (!path && (!item.folderId || item.fileType !== "folder")) return false;
    const actual = await realpath(resolve(root, path)).catch(() => null);
    if (!actual || actual !== root && !actual.startsWith(root.endsWith(sep) ? root : root + sep)) return false;
    const info = await stat(actual).catch(() => null);
    return item.fileType === "folder" ? info?.isDirectory() === true : info?.isFile() === true;
  }));
  return items.filter((_item, index) => visible[index]);
}
