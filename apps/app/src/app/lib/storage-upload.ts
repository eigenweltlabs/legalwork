import type { LegalworkServerClient } from "./legalwork-server";

export type StorageUploadEntry =
  | { kind: "folder"; path: string }
  | { kind: "file"; path: string; file: File };
type UploadFailure = { path: string; cause: unknown };
export type StorageUploadBatch = { entries: StorageUploadEntry[]; failures: UploadFailure[] };

// A structural subset also works where the browser does not expose entry constructors.
type DropEntry = {
  name: string;
  isDirectory: boolean;
  file?: (success: (file: File) => void, failure: (cause: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: DropEntry[]) => void, failure: (cause: DOMException) => void) => void;
  };
};
type DropData = {
  items: ArrayLike<{
    kind: string;
    webkitGetAsEntry?: () => DropEntry | null;
    getAsFile: () => File | null;
  }>;
  files: ArrayLike<File>;
};

export function storageUploadFiles(files: File[]): StorageUploadBatch {
  return { entries: files.map((file) => ({ kind: "file", path: file.name, file })), failures: [] };
}

export async function readStorageDrop(data: DropData): Promise<StorageUploadBatch> {
  // Capture every handle before the first await: the drag data store expires after onDrop.
  const sources = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  if (!sources.length) return storageUploadFiles(Array.from(data.files));
  const batch: StorageUploadBatch = { entries: [], failures: [] };
  const visit = async (entry: DropEntry, parent: string) => {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    try {
      if (entry.isDirectory) {
        if (!entry.createReader) throw new Error("This folder could not be read.");
        batch.entries.push({ kind: "folder", path });
        const reader = entry.createReader();
        // Chromium returns directory contents in batches, including an empty final batch.
        while (true) {
          const children = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) await visit(child, path);
        }
      } else {
        const file = await new Promise<File>((resolve, reject) => {
          if (entry.file) entry.file(resolve, reject);
          else reject(new Error("This file could not be read."));
        });
        batch.entries.push({ kind: "file", path, file });
      }
    } catch (cause) {
      batch.failures.push({ path, cause });
    }
  };
  for (const source of sources) {
    if (source.entry) await visit(source.entry, "");
    else if (source.file) batch.entries.push({ kind: "file", path: source.file.name, file: source.file });
    else batch.failures.push({ path: "", cause: new Error("A dropped item could not be read.") });
  }
  return batch;
}

type UploadClient = Pick<LegalworkServerClient, "createStorageFolder" | "storageChildren" | "writeStorageFile">;

export async function uploadStorageBatch(
  client: UploadClient,
  workspaceId: string,
  rootId: string,
  destination: string,
  batch: StorageUploadBatch,
  progress: (current: number, total: number, path: string) => void,
  active: () => boolean,
): Promise<UploadFailure[]> {
  const failures = [...batch.failures];
  const blocked = new Set<string>();
  const ensureFolder = async (path: string) => {
    try {
      await client.createStorageFolder(workspaceId, rootId, path);
    } catch (cause) {
      // Providers report conflicts differently. Only reuse a confirmed existing folder.
      const parent = path.split("/").slice(0, -1).join("/");
      let cursor: string | undefined;
      try {
        do {
          const page = await client.storageChildren(workspaceId, rootId, parent, cursor);
          if (page.entries.some((entry) => entry.kind === "folder" && entry.path === path)) return;
          cursor = page.nextCursor;
        } while (cursor);
      } catch {
        // Keep the original creation error when the parent cannot be listed either.
      }
      throw cause;
    }
  };
  for (const [index, entry] of batch.entries.entries()) {
    if (!active()) break;
    if ([...blocked].some((path) => entry.path === path || entry.path.startsWith(`${path}/`))) continue;
    progress(index + 1, batch.entries.length, entry.path);
    const path = destination ? `${destination}/${entry.path}` : entry.path;
    try {
      if (entry.kind === "folder") await ensureFolder(path);
      else await client.writeStorageFile(workspaceId, rootId, path, entry.file, entry.file.type || "application/octet-stream");
    } catch (cause) {
      failures.push({ path: entry.path, cause });
      if (entry.kind === "folder") blocked.add(entry.path);
    }
  }
  return failures;
}
