import { constants, type Stats } from "node:fs";
import { copyFile, realpath, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiError } from "./errors.js";

type TransferSource = { rootPath: string; root: string; relativePath: string; path: string; info: Stats };

/** Approval must still refer to the same file, including when a parent or file link was replaced. */
async function assertTransferSource(source: TransferSource) {
  const root = await realpath(source.rootPath).catch(() => null);
  const path = await realpath(resolve(source.root, source.relativePath)).catch(() => null);
  const info = path === source.path ? await stat(source.path).catch(() => null) : null;
  if (root !== source.root || path !== source.path || !info?.isFile()
    || info.dev !== source.info.dev || info.ino !== source.info.ino || info.size !== source.info.size
    || info.mtimeMs !== source.info.mtimeMs || info.ctimeMs !== source.info.ctimeMs) {
    throw new ApiError(409, "source_file_changed", "The source file changed while this transfer was pending. Choose the file again.");
  }
}

/** Never replace a destination; a changed source is never removed after a copy. */
export async function copyLauncherTransferFile(source: TransferSource, destination: string, move: boolean,
  copy: (source: string, destination: string) => Promise<void> = (from, to) => copyFile(from, to, constants.COPYFILE_EXCL)) {
  await assertTransferSource(source);
  await copy(source.path, destination);
  if (move) {
    try { await assertTransferSource(source); }
    catch { throw new ApiError(409, "source_file_changed", "A copy was created in the destination, but the source changed during the transfer and was not removed. Review both files before trying again."); }
    await unlink(source.path);
  }
}
