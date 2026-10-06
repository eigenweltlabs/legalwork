import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StorageEntry, StorageTransfer, StorageTransferProgress, StorageTransferUpdate } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import { conflict, findEntry, providerError, storagePath, type StorageAdapter } from "./common.js";

export function transferDestination(input: StorageTransfer, sameRoot: boolean) {
  storagePath(input.path, false);
  storagePath(input.destinationPath);
  const name = input.path.split("/").at(-1)!;
  const destination = storagePath(input.destinationPath ? `${input.destinationPath}/${name}` : name, false);
  if (sameRoot && (destination === input.path || (input.kind === "folder" && destination.startsWith(`${input.path}/`))))
    throw new ApiError(400, "invalid_storage_destination", "Choose a different folder outside the folder being transferred.");
  return destination;
}

async function snapshot(adapter: StorageAdapter, item: StorageEntry, onCount?: (files: number) => void) {
  const entries = [item];
  let count = item.kind === "file" ? 1 : 0;
  onCount?.(count);
  for (let index = 0; index < entries.length; index++) {
    const folder = entries[index];
    if (folder.kind !== "folder") continue;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const children = new Set<string>();
    do {
      const page = await adapter.list(folder.path, cursor);
      for (const child of page.entries) {
        storagePath(child.path, false);
        if (child.path.split("/").slice(0, -1).join("/") !== folder.path || children.has(child.path))
          throw new ApiError(502, "storage_invalid_response", "Storage returned an invalid folder listing.");
        children.add(child.path);
        entries.push(child);
        if (child.kind === "file") count++;
      }
      onCount?.(count);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ApiError(502, "storage_invalid_response", "Storage repeated a folder page.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  return entries;
}

/** Transfer on the server, streaming one file at a time and retaining originals until verification succeeds. */
export async function transferEntry(source: StorageAdapter, target: StorageAdapter, input: StorageTransfer, sameRoot: boolean, onProgress?: (progress: StorageTransferProgress) => void) {
  let phase: StorageTransferProgress["phase"] = "scanning";
  let phaseStartedAt = performance.now();
  const report = (update: StorageTransferUpdate) => {
    if (update.phase !== phase) { phase = update.phase; phaseStartedAt = performance.now(); }
    onProgress?.({ ...update, elapsedMs: performance.now() - phaseStartedAt });
  };
  report({ phase: "scanning", completedFiles: 0, totalFiles: null });
  const destination = transferDestination(input, sameRoot);
  const original = await findEntry(source, input.path, input.kind);
  if (!original) throw new ApiError(404, "storage_not_found", "File or folder not found. Refresh before transferring.");
  if (input.destinationPath && !await findEntry(target, input.destinationPath, "folder"))
    throw new ApiError(404, "storage_not_found", "The destination folder no longer exists. Refresh Memory Drive.");
  if (await findEntry(target, destination)) conflict();
  if (sameRoot && input.mode === "move" && source.rename && !onProgress) {
    await source.rename(input.path, destination, input.kind);
    return destination;
  }
  if (input.mode === "move" && !(sameRoot && source.rename) && (!source.deleteFile || (input.kind === "folder" && !source.deleteFolder)))
    throw new ApiError(400, "storage_move_unsupported", "This connection cannot remove the original. Copy the item instead.");
  const entries = await snapshot(source, original, (count) => report({ phase: "scanning", completedFiles: count, totalFiles: null }));
  const totalFiles = entries.filter((item) => item.kind === "file").length;
  report({ phase: "transferring", completedFiles: 0, totalFiles });
  if (sameRoot && input.mode === "move" && source.rename) {
    await source.rename(input.path, destination, input.kind, report);
    report({ phase: "completed", completedFiles: totalFiles, totalFiles });
    return destination;
  }
  const directory = await mkdtemp(join(tmpdir(), "legalwork-transfer-"));
  const staged = join(directory, "content");
  const files: { path: string; destination: string; sha256: string; version: string }[] = [];
  let started = false;
  let removing = false;
  try {
    for (const item of entries) {
      const path = destination + item.path.slice(input.path.length);
      if (item.kind === "folder") {
        await target.mkdir(path);
        started = true;
        continue;
      }
      report({ phase: "transferring", completedFiles: files.length, totalFiles, currentFile: item.path });
      const downloaded = await source.download(item.path, staged);
      try {
        await target.upload(path, staged, downloaded.contentType ?? "application/octet-stream", { createOnly: true });
        started = true;
        if ((await target.download(path)).sha256 !== downloaded.sha256) conflict();
        files.push({ path: item.path, destination: path, sha256: downloaded.sha256, version: downloaded.version });
        report({ phase: "transferring", completedFiles: files.length, totalFiles, currentFile: item.path });
      } finally {
        await rm(staged, { force: true });
      }
    }
    if (input.mode === "move") {
      report({ phase: "verifying", completedFiles: 0, totalFiles });
      // Recheck all originals and copies before removing anything, including newly added children.
      const current = await snapshot(source, original);
      const paths = new Set(current.map((item) => `${item.kind}:${item.path}`));
      if (paths.size !== entries.length || entries.some((item) => !paths.has(`${item.kind}:${item.path}`))) conflict();
      for (const [index, file] of files.entries()) {
        const original = await source.download(file.path);
        if (original.sha256 !== file.sha256 || original.version !== file.version || (await target.download(file.destination)).sha256 !== file.sha256)
          conflict();
        report({ phase: "verifying", completedFiles: index + 1, totalFiles, currentFile: file.path });
      }
      removing = true;
      report({ phase: "removing", completedFiles: 0, totalFiles });
      for (const [index, file] of files.entries()) {
        await source.deleteFile!(file.path, { version: file.version });
        report({ phase: "removing", completedFiles: index + 1, totalFiles, currentFile: file.path });
      }
      for (const item of [...entries].reverse()) {
        if (item.kind !== "folder") continue;
        // Virtual object-store folders disappear as soon as their last object is removed.
        if (!await findEntry(source, item.path, "folder")) continue;
        const remaining = await source.list(item.path);
        if (remaining.entries.length || remaining.nextCursor) conflict();
        await source.deleteFolder!(item.path, false);
      }
    }
    report({ phase: "completed", completedFiles: totalFiles, totalFiles });
    return destination;
  } catch (error) {
    if (!started) throw error;
    const failure = providerError(error);
    throw new ApiError(failure.status, "storage_transfer_incomplete", removing
      ? `The copy was verified, but removing the original did not finish. Items may remain in both locations. Refresh both folders before retrying. ${failure.message}`
      : `The transfer did not finish. Originals were kept, and some copies may exist in the destination. Refresh both folders before retrying. ${failure.message}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
