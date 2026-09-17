import type { LegalworkTaskAttachment } from "./legalwork-server";

export const TASK_ATTACHMENT_DRAG_TYPE = "application/x-legalwork-task-attachment";

export type TaskAttachmentDragItem = {
  taskId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasTaskAttachmentDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(TASK_ATTACHMENT_DRAG_TYPE);
}

export function writeTaskAttachmentDrag(
  dataTransfer: DataTransfer,
  taskId: string,
  attachment: LegalworkTaskAttachment,
): void {
  const item: TaskAttachmentDragItem = {
    taskId,
    attachmentId: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
  };
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(TASK_ATTACHMENT_DRAG_TYPE, JSON.stringify(item));
  dataTransfer.setData("text/plain", attachment.filename);
}

export function readTaskAttachmentDrag(dataTransfer: DataTransfer): TaskAttachmentDragItem | null {
  const raw = dataTransfer.getData(TASK_ATTACHMENT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const item: unknown = JSON.parse(raw);
    if (!isRecord(item)) return null;
    const { taskId, attachmentId, filename, contentType } = item;
    if (
      typeof taskId !== "string" ||
      typeof attachmentId !== "string" ||
      typeof filename !== "string" ||
      typeof contentType !== "string" ||
      !taskId ||
      !attachmentId ||
      !filename
    ) return null;
    return { taskId, attachmentId, filename, contentType };
  } catch {
    return null;
  }
}
