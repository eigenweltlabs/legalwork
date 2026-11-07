import { readdir, rm } from "node:fs/promises";
import path from "node:path";

/** Reset application settings without deleting durable project homes or files. */
export async function clearDesktopProfile(directory, protectedRoots = []) {
  const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const contains = (parent, child) => {
    const suffix = path.relative(key(parent), key(child));
    return !suffix || !path.isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${path.sep}`);
  };
  const roots = [path.join(directory, "Projects"), ...protectedRoots.filter(value => typeof value === "string" && value.trim())];
  const entries = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  for (const name of entries) {
    const target = path.join(directory, name);
    if (roots.some(root => contains(target, root) || contains(root, target))) continue;
    await rm(target, { recursive: true, force: true });
  }
}
