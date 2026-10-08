import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { keepWorkspaceSnapshot, snapshotWorkspaceFile } from "./file-storage/working-copy.js";

/** Pin every source before publishing, so a bad or inaccessible file prevents the handoff. */
export async function copyAssistantFiles(sourceRoot: string, targetRoot: string, paths: string[], approve: (paths: string[]) => Promise<void>) {
  const snapshots: { sourcePath: string; path: string; file: Awaited<ReturnType<typeof snapshotWorkspaceFile>> }[] = [];
  const folder = `Files/Assistant/${randomUUID()}`;
  try {
    for (const sourcePath of [...new Set(paths)]) {
      const file = await snapshotWorkspaceFile(sourceRoot, sourcePath);
      snapshots.push({ sourcePath, path: `${folder}/${snapshots.length + 1}-${basename(sourcePath)}`, file });
    }
    if (snapshots.length) await approve(snapshots.map(item => item.path));
    const copied = [];
    for (const item of snapshots) {
      const saved = await keepWorkspaceSnapshot(targetRoot, item.file.path, item.path);
      copied.push({ sourcePath: item.sourcePath, ...saved });
    }
    return copied;
  } finally {
    await Promise.all(snapshots.map(item => item.file.remove()));
  }
}
