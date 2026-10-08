import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { projectFileLinkSchema, projectFilePath, type ProjectFileLink } from "@legalwork/types/project-files";
import { ApiError } from "./errors.js";
import { withFileWriteLock } from "./file-write-lock.js";

/** Validate existing parents too: lexical path checks alone don't contain symlinks. */
export async function projectFileParent(root: string, folder: string) {
  if (folder && !projectFilePath.safeParse(folder).success) throw new ApiError(400, "invalid_path", "Invalid destination folder");
  const canonical = await realpath(root);
  const parent = await realpath(join(canonical, folder));
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
    throw error;
  }
}
export async function updateProjectFileLinks(root: string, change: (links: ProjectFileLink[]) => ProjectFileLink[]) {
  const path = await linksPath(root, true);
  return withFileWriteLock(path, async () => {
    const links = change(await readProjectFileLinks(root));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(links), { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return links;
  });
}
/** Publish complete bytes exclusively. A collision never overwrites a file or symlink. */
export async function importProjectFile(root: string, path: string, bytes: Uint8Array) {
  if (!projectFilePath.safeParse(path).success) throw new ApiError(400, "invalid_path", "Invalid destination file");
  const parent = await projectFileParent(root, dirname(path) === "." ? "" : dirname(path));
  const destination = join(parent, path.split("/").pop()!);
  const temporary = join(parent, `.legalwork-import-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await link(temporary, destination);
    return { path, bytes: bytes.byteLength, updatedAt: (await stat(destination)).mtimeMs };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new ApiError(409, "file_exists", "A file with this name already exists. Choose another name.");
    throw error;
  } finally { await rm(temporary, { force: true }); }
}
