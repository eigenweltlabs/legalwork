import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { link, mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "../errors.js";
import { receiveFile, storagePath, providerError } from "./common.js";

const within = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const outside = () =>
  new ApiError(403, "storage_local_path_outside_workspace", "The file must remain inside this workspace.");

export async function workingCopy(root: string, name: string) {
  const canonical = await realpath(root);
  let parent = canonical;
  for (const part of [".legalwork", "storage-downloads"]) {
    const path = join(parent, part);
    await mkdir(path, { recursive: true, mode: 0o700 });
    parent = await realpath(path);
    if (!within(canonical, parent)) throw outside();
  }
  const directory = await mkdtemp(join(parent, "file-"));
  const path = join(directory, basename(name));
  return {
    path,
    relativePath: relative(canonical, path).split(sep).join("/"),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Pin a task file before an upload, including while an external editor saves. */
export async function snapshotWorkspaceFile(root: string, path: string) {
  const canonical = await realpath(root);
  const target = await realpath(resolve(canonical, path));
  if (!within(canonical, target)) throw outside();
  const directory = await mkdtemp(join(tmpdir(), "legalwork-upload-"));
  const staged = join(directory, "content");
  try {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new ApiError(400, "storage_not_a_file", "Choose a file to upload.");
      const result = await receiveFile(handle.createReadStream({ autoClose: false }), staged);
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
        throw new ApiError(
          409,
          "storage_local_file_changed",
          "The working copy changed during this save. Save again when editing is complete.",
        );
      return { path: staged, ...result, remove: () => rm(directory, { recursive: true, force: true }) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function keepWorkspaceCopy(root: string, source: string, destination: string) {
  storagePath(destination, false);
  const canonical = await realpath(root);
  const parts = destination.split("/");
  const name = parts.pop()!;
  let parent = canonical;
  for (const part of parts) {
    const path = join(parent, part);
    await mkdir(path, { recursive: true });
    parent = await realpath(path);
    if (!within(canonical, parent)) throw outside();
  }
  const snapshot = await snapshotWorkspaceFile(root, source);
  const target = join(parent, name);
  const staged = join(parent, `.legalwork-copy-${randomUUID()}.tmp`);
  try {
    const result = await receiveFile(createReadStream(snapshot.path), staged);
    // Publish the complete file exclusively; preserve an existing file or symlink.
    await link(staged, target);
    return { path: destination, bytes: result.size, updatedAt: (await stat(target)).mtimeMs };
  } catch (error) {
    throw providerError(error);
  } finally {
    await rm(staged, { force: true });
    await snapshot.remove();
  }
}
