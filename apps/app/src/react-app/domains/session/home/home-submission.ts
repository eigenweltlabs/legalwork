import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { createHomeMessage, type HomeMessage } from "./home-message";
import { replaceHomeAttachmentTokens, resolveHomeFileReference, type HomeDraftAttachment, type HomeFileClient, type HomeFileContent, type HomeFileReference } from "./home-attachments";
import {
  uploadWorkspaceAttachment,
  workspaceAttachmentDisplayText,
  workspaceAttachmentInstruction,
} from "../surface/composer/workspace-attachment";

/** Keep completed steps so a failed upload or send can be retried safely. */
export type PendingHomeMessage = {
  sessionId: string | null;
  message?: HomeMessage;
  uploads: Map<File, string>;
  references?: Map<HomeFileReference, HomeFileContent>;
};

export async function submitHomeMessage(input: {
  workspaceId: string;
  text: string;
  files: File[];
  references?: HomeFileReference[];
  referenceClient?: HomeFileClient;
  attachments?: HomeDraftAttachment[];
  pending: PendingHomeMessage;
  client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile">;
  createSession: () => Promise<{ id: string }>;
  sendPrompt: (sessionId: string, text: string, fileContext: string, message: HomeMessage) => Promise<void>;
}) {
  const content = new Map<File | HomeFileReference, HomeFileContent>();
  for (const file of input.files) {
    let reference = input.pending.uploads.get(file);
    if (!reference) {
      reference = await uploadWorkspaceAttachment(input.client, input.workspaceId, file);
      input.pending.uploads.set(file, reference);
    }
    content.set(file, { text: workspaceAttachmentDisplayText(reference), context: workspaceAttachmentInstruction(reference) });
  }
  for (const reference of input.references ?? []) {
    input.pending.references ??= new Map();
    let resolved = input.pending.references.get(reference);
    if (!resolved) {
      if (!input.referenceClient) throw new Error("File reference client unavailable");
      resolved = await resolveHomeFileReference(input.referenceClient, input.workspaceId, reference);
      input.pending.references.set(reference, resolved);
    }
    content.set(reference, resolved);
  }
  if (!input.pending.sessionId) {
    input.pending.sessionId = (await input.createSession()).id;
  }
  await input.sendPrompt(
    input.pending.sessionId,
    input.attachments
      ? replaceHomeAttachmentTokens(input.text.trim(), input.attachments, (attachment) => {
          const resolved = content.get(attachment.source);
          if (!resolved) throw new Error("Attachment was not resolved");
          return resolved.text;
        })
      : [input.text.trim(), ...Array.from(content.values(), (file) => file.text)].filter(Boolean).join("\n\n"),
    Array.from(content.values(), (file) => file.context).join("\n\n"),
    input.pending.message ??= createHomeMessage(),
  );
  return input.pending.sessionId;
}
