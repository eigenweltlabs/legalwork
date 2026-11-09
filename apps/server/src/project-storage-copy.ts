import { chmod, cp, lstat, mkdir, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { excludeProjectSupport } from "./project-storage-exclusions.js";

/** Keep native file/symlink copying and metadata preservation, reporting files
 * only after their copy completes. No source links are followed. */
export async function copyProjectSupport(source: string, destination: string, copied: () => void): Promise<void> {
  const info = await lstat(source);
  if (await excludeProjectSupport(source, info)) return;
  if (!info.isDirectory()) {
    await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    copied();
    return;
  }
  await mkdir(destination, { mode: 0o700 });
  for (const name of await readdir(source)) await copyProjectSupport(join(source, name), join(destination, name), copied);
  await chmod(destination, info.mode);
  await utimes(destination, info.atime, info.mtime);
}
