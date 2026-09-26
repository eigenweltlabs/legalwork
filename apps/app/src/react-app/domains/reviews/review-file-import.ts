import { isReviewFile, REVIEW_MAX_DOCUMENTS, REVIEW_MAX_FILE_BYTES } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { hasWorkspaceFileDrag, readWorkspaceFileDrag, type WorkspaceFileDragItem } from "@/app/lib/workspace-file-drag";
import { hasStorageFileDrag, materializeStorageFile, readStorageFileDrag, type StorageFileDragItem } from "@/app/lib/storage-file-drag";
import { hasLegalMemoryFileDrag, materializeLegalMemoryFile, readLegalMemoryFileDrag, type LegalMemoryFileDragItem } from "@/app/lib/legalmemory-file";
import { t } from "@/i18n";

export type ReviewFileSource =
  | { kind: "upload"; file: File }
  | { kind: "workspace"; file: WorkspaceFileDragItem }
  | { kind: "storage"; file: StorageFileDragItem }
  | { kind: "memory"; file: LegalMemoryFileDragItem };
export type ReviewFileClient = Pick<LegalworkServerClient, "statWorkspaceFile" | "writeWorkspaceBinaryFile" | "downloadWorkspaceFile" | "checkoutStorageFile" | "legalMemoryOpen">;

export function acceptsReviewFiles(data: DataTransfer) {
  return hasWorkspaceFileDrag(data) || hasStorageFileDrag(data) || hasLegalMemoryFileDrag(data) || Array.from(data.types).includes("Files");
}

/** Read synchronously: browsers clear the drag data store after the drop event. */
export function readReviewFiles(data: DataTransfer): ReviewFileSource[] {
  if (hasWorkspaceFileDrag(data)) { const file = readWorkspaceFileDrag(data); return file ? [{ kind: "workspace", file }] : []; }
  if (hasStorageFileDrag(data)) { const file = readStorageFileDrag(data); return file ? [{ kind: "storage", file }] : []; }
  if (hasLegalMemoryFileDrag(data)) { const file = readLegalMemoryFileDrag(data); return file ? [{ kind: "memory", file }] : []; }
  return Array.from(data.files).map(file => ({ kind: "upload", file }));
}

function validateFile(name: string, size?: number) {
  if (!isReviewFile(name)) throw new Error(t("review.file_unsupported"));
  if (size !== undefined && size > REVIEW_MAX_FILE_BYTES) throw new Error(t("review.file_too_large"));
}

async function projectFile(client: ReviewFileClient, workspaceId: string, path: string) {
  const stat = await client.statWorkspaceFile(workspaceId, path);
  if (!stat.exists || stat.kind !== "file") throw new Error(t("review.file_unavailable"));
  validateFile(stat.path, stat.size);
  return stat.path;
}

async function copyUpload(client: ReviewFileClient, workspaceId: string, file: File) {
  validateFile(file.name, file.size);
  const data = await file.arrayBuffer();
  const safeName = file.name.replace(/[\x00-\x1f/\\:*?"<>|]/g, "_").replace(/[. ]+$/, "");
  const filename = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(safeName) ? `_${safeName}` : safeName;
  const extension = filename.lastIndexOf(".");
  // Keep readable names on disk. Reuse identical imports, and number collisions
  // rather than overwriting a different document with the same filename.
  for (let suffix = 1; suffix <= 1000; suffix++) {
    const name = suffix === 1 ? filename : `${filename.slice(0, extension)} (${suffix})${filename.slice(extension)}`;
    const path = `Review documents/${name}`;
    const existing = await client.statWorkspaceFile(workspaceId, path);
    if (existing.exists) {
      if (existing.kind === "file" && existing.size === data.byteLength) {
        const stored = await client.downloadWorkspaceFile(workspaceId, path);
        const bytes = new Uint8Array(stored.data);
        if (bytes.length === data.byteLength && new Uint8Array(data).every((byte, index) => byte === bytes[index])) return path;
      }
      continue;
    }
    const written = await client.writeWorkspaceBinaryFile(workspaceId, { path, data });
    if (!written.ok || !written.path) throw new Error(t("workspace.upload_incomplete"));
    return projectFile(client, workspaceId, written.path);
  }
  throw new Error(t("review.file_name_conflict"));
}

export async function importReviewFile(client: ReviewFileClient, workspaceId: string, source: ReviewFileSource): Promise<string> {
  if (source.kind === "upload") return copyUpload(client, workspaceId, source.file);
  if (source.kind === "workspace") {
    const path = await projectFile(client, source.file.workspaceId, source.file.path);
    if (source.file.workspaceId === workspaceId) return path;
    const download = await client.downloadWorkspaceFile(source.file.workspaceId, path);
    return copyUpload(client, workspaceId, new File([download.data], path.split(/[\\/]/).at(-1) ?? source.file.name, { type: download.contentType ?? undefined }));
  }
  if (source.kind === "storage") {
    validateFile(source.file.name);
    const copy = await materializeStorageFile(client, workspaceId, source.file);
    return projectFile(client, workspaceId, copy.localPath);
  }
  const copy = await materializeLegalMemoryFile(client, workspaceId, source.file.document_id);
  return projectFile(client, workspaceId, copy.path);
}

/** Keep successful files even when another source is unsupported or offline. */
export async function importReviewFiles(options: {
  client: ReviewFileClient; workspaceId: string; sources: ReviewFileSource[]; existing: string[];
  onProgress?: (index: number, total: number, name: string) => void; signal?: AbortSignal;
}) {
  const paths = new Set(options.existing), failures: string[] = [];
  const added: string[] = [];
  for (const [index, source] of options.sources.entries()) {
    options.signal?.throwIfAborted();
    const name = source.file.name;
    options.onProgress?.(index + 1, options.sources.length, name);
    try {
      // Existing project references may still be dropped again at the limit.
      if (paths.size >= REVIEW_MAX_DOCUMENTS && !(source.kind === "workspace" && source.file.workspaceId === options.workspaceId && paths.has(source.file.path)))
        throw new Error(t("review.file_limit"));
      const path = await importReviewFile(options.client, options.workspaceId, source);
      options.signal?.throwIfAborted();
      if (!paths.has(path)) { paths.add(path); added.push(path); }
    } catch (error) {
      options.signal?.throwIfAborted();
      failures.push(`${name}: ${error instanceof Error ? error.message : t("review.failed")}`);
    }
  }
  return { paths: added, failures };
}
