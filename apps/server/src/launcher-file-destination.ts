import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

/** Reject symlinks/junctions at every destination component, including during
 * the approval wait. Never create a directory before checking its parent. */
export async function launcherDestination(root: string, folder: string, create = false): Promise<string> {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of folder.split(/[\\/]/).filter(Boolean)) {
    if (segment === "." || segment === "..") throw new ApiError(400, "invalid_path", "Choose a folder inside the destination project.");
    current = resolve(current, segment);
    let info = await lstat(current).catch(error => { if (error?.code === "ENOENT") return null; throw error; });
    if (!info && create) { await mkdir(current).catch(error => { if (error?.code !== "EEXIST") throw error; }); info = await lstat(current); }
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ApiError(400, "invalid_path", "The destination must be a folder inside the project, not a linked folder.");
    const actual = await realpath(current);
    if (!actual.startsWith(canonicalRoot + sep) || actual !== current) throw new ApiError(400, "invalid_path", "The destination is outside the project.");
  }
  return current;
}
