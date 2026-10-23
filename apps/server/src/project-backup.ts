import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";
import { createDefaultProjectFolder } from "./project-store.js";
import { assertProjectFolderIndependent } from "./wiki/workspace-safety.js";
import { WikiStore } from "./wiki/store.js";
import type { ServerConfig } from "./types.js";
import { canonicalFilePath } from "./file-write-lock.js";

type Entry = { path: string; kind: "directory" | "file" | "link"; content: string; mode: number };
const contains = (root: string, path: string) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
};
async function digest(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally { await file.close(); }
}

// Include hidden documents/attachments; never traverse linked directories.
async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function visit(folder: string, depth: number) {
    if (depth > 64) throw new Error("The project has too many nested folders");
    for (const name of (await readdir(join(root, folder))).sort()) {
      if (entries.length >= 250_000) throw new Error("The project has too many entries to back up in one operation");
      const path = join(folder, name), absolute = join(root, path), info = await lstat(absolute);
      if (info.isSymbolicLink()) entries.push({ path, kind: "link", content: await readlink(absolute), mode: 0 });
      else if (info.isDirectory()) {
        entries.push({ path, kind: "directory", content: "", mode: info.mode & 0o777 });
        await visit(path, depth + 1);
      } else if (info.isFile()) entries.push({ path, kind: "file", content: await digest(absolute), mode: info.mode & 0o777 });
      else throw new Error(`Unsupported filesystem entry: ${path}`);
    }
  }
  await visit("", 0);
  return entries;
}

/** Publish a complete verified copy before any chat or source file is deleted. */
export async function backupProjectFolder(config: ServerConfig, source: string, directory: string) {
  if (!isAbsolute(directory)) throw new ApiError(400, "invalid_backup_folder", "Choose an absolute path to a backup folder on this computer.");
  const root = await realpath(source);
  const parent = await realpath(directory).catch(() => {
    throw new ApiError(400, "invalid_backup_folder", "Choose an existing, accessible folder for the backup.");
  });
  if (contains(root, parent)) throw new ApiError(400, "invalid_backup_folder", "Choose a backup location outside the project folder.");
  if (!(await lstat(parent)).isDirectory()) throw new ApiError(400, "invalid_backup_folder", "Choose an existing folder for the backup.");
  const wikis = await new WikiStore(config).list();
  await assertProjectFolderIndependent(join(parent, `${basename(source)} backup`), wikis);
  const destination = await createDefaultProjectFolder(`${basename(source)} backup`, parent).catch(() => {
    throw new ApiError(400, "invalid_backup_folder", "A backup folder could not be created here. Choose a writable location with enough free space.");
  });
  let original: Entry[];
  const expected: Entry[] = [];
  try {
    await assertProjectFolderIndependent(destination, wikis);
    original = await inventory(root);
    for (const entry of original) {
      const from = join(root, entry.path), to = join(destination, entry.path);
      if (entry.kind === "directory") await mkdir(to);
      else if (entry.kind === "file") {
        await copyFile(from, to, constants.COPYFILE_EXCL);
        await chmod(to, entry.mode);
      } else {
        // Keep internal references working in the copy and external references
        // pointing at the same original, without copying external contents.
        const target = await canonicalFilePath(resolve(dirname(from), entry.content));
        const content = contains(root, target) ? relative(dirname(to), join(destination, relative(root, target))) || "." : target;
        await symlink(content, to);
        expected.push({ ...entry, content });
        continue;
      }
      expected.push(entry);
    }
    // Apply directory modes after copying their children (read-only folders).
    for (const entry of [...original].reverse()) if (entry.kind === "directory") await chmod(join(destination, entry.path), entry.mode);
    if (JSON.stringify(await inventory(destination)) !== JSON.stringify(expected)) throw new Error("The backup could not be verified");
    if (JSON.stringify(await inventory(root)) !== JSON.stringify(original)) throw new Error("The project changed while being backed up");
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw new ApiError(409, "project_backup_failed", `The backup did not finish. No project data has been deleted. ${error instanceof Error ? error.message : "Check the destination folder and try again."}`);
  }
  return {
    path: destination,
    async verify() {
      try {
        if (await realpath(source) === root && JSON.stringify(await inventory(root)) === JSON.stringify(original)
          && JSON.stringify(await inventory(destination)) === JSON.stringify(expected)) return;
      } catch { /* An inaccessible source or backup is never grounds to delete. */ }
      throw new ApiError(409, "project_backup_changed", `The project or backup changed after copying. The project folder has been kept. The backup location is ${destination}. Review and back up the project again before deleting it.`);
    },
  };
}
