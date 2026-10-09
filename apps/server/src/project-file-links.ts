import { randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { projectFileLinkSchema, projectFilePath, type ProjectFileLink } from "./project-file-schema.js";
import { ApiError } from "./errors.js";
import { withFileWriteLock } from "./file-write-lock.js";

/** Validate existing parents too: lexical path checks alone don't contain symlinks. */
export async function projectFileParent(root: string, folder: string) {
  if (folder && !projectFilePath.safeParse(folder).success) throw new ApiError(400, "invalid_path", "Invalid destination folder");
  const canonical = await realpath(root);
  const parent = await realpath(join(canonical, folder)).catch(error => {
    if (error?.code === "ENOENT") throw new ApiError(404, "folder_not_found", "The destination folder no longer exists. Choose another folder.");
    throw error;
  });
  const path = relative(canonical, parent);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) throw new ApiError(403, "invalid_path", "The destination must remain in the project");
  if (!(await stat(parent)).isDirectory()) throw new ApiError(400, "invalid_path", "Choose a destination folder");
  return parent;
}
async function linksPath(root: string, create = false) {
  const parent = join(await realpath(root), ".legalwork");
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  return join(await projectFileParent(root, ".legalwork"), "project-file-links.json");
}
export async function readProjectFileLinks(root: string): Promise<ProjectFileLink[]> {
  try {
    const path = await linksPath(root);
    if ((await lstat(path)).isSymbolicLink()) throw new ApiError(403, "invalid_path", "Project links must not be a symbolic link");
    return z.array(projectFileLinkSchema).parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    if (error instanceof ApiError && error.code === "folder_not_found") return [];
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new ApiError(409, "invalid_project_file_links", "Project file links are damaged. Restore the links file before changing links; the original file has been preserved.");
    throw error;
  }
}
export async function updateProjectFileLinks(root: string, change: (links: ProjectFileLink[]) => ProjectFileLink[] | Promise<ProjectFileLink[]>) {
  const path = await linksPath(root, true);
  return withFileWriteLock(path, async () => {
    const links = await change(await readProjectFileLinks(root));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(links), { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return links;
  });
}
/** Publish exclusively. A collision never overwrites a file or symlink. */
export async function importProjectFile(root: string, path: string, bytes: Uint8Array) {
  if (!projectFilePath.safeParse(path).success) throw new ApiError(400, "invalid_path", "Invalid destination file");
  const parent = await projectFileParent(root, dirname(path) === "." ? "" : dirname(path));
  const destination = join(parent, path.split("/").pop()!);
  const temporary = join(parent, `.legalwork-import-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try { await link(temporary, destination); }
    catch (error) {
      // exFAT/FAT and some network shares do not support hard links. COPYFILE_EXCL
      // still refuses existing files/symlinks and removes a partial copy on failure.
      if (!(error instanceof Error && "code" in error && ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"].includes(String(error.code)))) throw error;
      await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    }
    return { path, bytes: bytes.byteLength, updatedAt: (await stat(destination)).mtimeMs };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new ApiError(409, "file_exists", "A file with this name already exists. Choose another name.");
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

/** Rename the folder and its virtual children under the same metadata lock.
 * Prepare the new metadata first; roll the folder back if publication fails. */
export async function renameProjectFileEntry(root: string, from: string, to: string) {
  const source = join(root, from), destination = join(root, to);
  if (!(await stat(source)).isDirectory()) { await rename(source, destination); return; }
  const path = await linksPath(root, true);
  await withFileWriteLock(path, async () => {
    const links = await readProjectFileLinks(root);
    const affected = (folder: string) => folder === from || folder.startsWith(`${from}/`);
    if (!links.some(link => affected(link.folder))) { await rename(source, destination); return; }
    const next = links.map(link => affected(link.folder) ? { ...link, folder: `${to}${link.folder.slice(from.length)}` } : link);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(source, destination);
      try { await rename(temporary, path); }
      catch (error) { await rename(destination, source); throw error; }
    } finally { await rm(temporary, { force: true }); }
  });
}
