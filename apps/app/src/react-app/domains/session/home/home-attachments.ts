import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { hasWorkspaceFileDrag, readWorkspaceFileDrag, type WorkspaceFileDragItem } from "@/app/lib/workspace-file-drag";
import { hasStorageFileDrag, readStorageFileDrag, materializeStorageFile, type StorageFileDragItem } from "@/app/lib/storage-file-drag";
import { hasLegalMemoryFileDrag, readLegalMemoryFileDrag, materializeLegalMemoryFile, type LegalMemoryFileDragItem } from "@/app/lib/legalmemory-file";
import { t } from "@/i18n";
import { createWorkspaceAttachmentMention, uploadWorkspaceAttachment, workspaceAttachmentDisplayText, workspaceAttachmentInstruction } from "../surface/composer/workspace-attachment";
import {
  createStorageComposerMention, storageComposerDisplayText, storageComposerInstruction,
  createLegalMemoryComposerMention, legalMemoryComposerDisplayText, legalMemoryComposerInstruction,
  encodeComposerMentionValue, decodeComposerMentionValue, type ComposerMentionKind,
} from "../surface/composer/mention-encoding";

export type HomeFileReference =
  | { kind: "workspace"; file: WorkspaceFileDragItem }
  | { kind: "storage"; file: StorageFileDragItem }
  | { kind: "memory"; file: LegalMemoryFileDragItem };

export type HomeFileContent = { text: string; context: string };
export type HomeDraftAttachment = { source: File | HomeFileReference; value: string; kind: ComposerMentionKind };

/** Use the chat editor's existing mention nodes while the target project is undecided. */
export function stageHomeAttachment(source: File | HomeFileReference): HomeDraftAttachment {
  if (source instanceof File) return { source, kind: "upload", value: createWorkspaceAttachmentMention(source.name, `pending/${crypto.randomUUID()}`) };
  const file = source.file;
  if (source.kind === "storage") return { source, kind: "storage", value: createStorageComposerMention(source.file.connectionId, file.path, file.name) };
  if (source.kind === "memory") return { source, kind: "memory", value: createLegalMemoryComposerMention(source.file.document_id, file.name) };
  return { source, kind: "upload", value: `${createWorkspaceAttachmentMention(file.name, file.path)}&workspace=${encodeURIComponent(source.file.workspaceId)}` };
}

export function homeAttachmentToken(attachment: HomeDraftAttachment) {
  return `@${encodeComposerMentionValue(attachment.value)}`;
}

export function activeHomeAttachments(text: string, attachments: HomeDraftAttachment[]) {
  const values = new Set(Array.from(text.matchAll(/@([^\s@]+)/g), (match) => decodeComposerMentionValue(match[1])));
  return attachments.filter((attachment) => values.has(attachment.value));
}

export function replaceHomeAttachmentTokens(text: string, attachments: HomeDraftAttachment[], render: (attachment: HomeDraftAttachment) => string) {
  const byValue = new Map(attachments.map((attachment) => [attachment.value, attachment]));
  return text.replace(/@([^\s@]+)/g, (token, value: string) => {
    const attachment = byValue.get(decodeComposerMentionValue(value));
    return attachment ? render(attachment) : token;
  });
}

export type HomeFileClient = Pick<LegalworkServerClient,
  "statWorkspaceFile" | "downloadWorkspaceFile" | "writeWorkspaceBinaryFile" | "checkoutStorageFile" | "legalMemoryOpen"
>;

export function hasHomeFileDrop(data: DataTransfer) {
  return data.types.includes("Files") || hasWorkspaceFileDrag(data) || hasStorageFileDrag(data) || hasLegalMemoryFileDrag(data);
}

export function readHomeFileReference(data: DataTransfer): HomeFileReference | null {
  const workspace = readWorkspaceFileDrag(data);
  if (workspace) return { kind: "workspace", file: workspace };
  const memory = readLegalMemoryFileDrag(data);
  if (memory) return { kind: "memory", file: memory };
  const storage = readStorageFileDrag(data);
  return storage ? { kind: "storage", file: storage } : null;
}

/** Resolve against the final project, including when Home creates it on send. */
export async function resolveHomeFileReference(client: HomeFileClient, workspaceId: string, reference: HomeFileReference): Promise<HomeFileContent> {
  if (reference.kind === "memory") {
    const file = reference.file;
    const copy = await materializeLegalMemoryFile(client, workspaceId, file.document_id);
    const mention = createLegalMemoryComposerMention(file.document_id, file.name, copy.path);
    return { text: legalMemoryComposerDisplayText(mention), context: legalMemoryComposerInstruction(mention) };
  }
  if (reference.kind === "storage") {
    const file = reference.file;
    const copy = await materializeStorageFile(client, workspaceId, file);
    const mention = createStorageComposerMention(file.connectionId, file.path, file.name, copy.localPath);
    return { text: storageComposerDisplayText(mention), context: storageComposerInstruction(mention) };
  }

  const file = reference.file;
  let mention: string;
  if (file.workspaceId === workspaceId) {
    const stat = await client.statWorkspaceFile(workspaceId, file.path);
    if (!stat.exists || stat.kind !== "file") throw new Error(t("composer.workspace_file_unavailable"));
    mention = createWorkspaceAttachmentMention(file.name, file.path);
  } else {
    const download = await client.downloadWorkspaceFile(file.workspaceId, file.path);
    const filename = file.path.split(/[\\/]/).pop() || file.name;
    const copy = new File([download.data], filename, { type: download.contentType ?? "application/octet-stream" });
    mention = await uploadWorkspaceAttachment(client, workspaceId, copy, file.name);
  }
  return { text: workspaceAttachmentDisplayText(mention), context: workspaceAttachmentInstruction(mention) };
}
