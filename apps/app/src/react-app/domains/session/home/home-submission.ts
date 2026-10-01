import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import {
  uploadWorkspaceAttachment,
  workspaceAttachmentDisplayText,
  workspaceAttachmentInstruction,
} from "../surface/composer/workspace-attachment";

/** Keep completed steps so a failed upload or send can be retried safely. */
export type PendingHomeMessage = {
  sessionId: string | null;
  uploads: Map<File, string>;
};

export async function submitHomeMessage(input: {
  workspaceId: string;
  text: string;
  files: File[];
  pending: PendingHomeMessage;
  client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile">;
  createSession: () => Promise<{ id: string }>;
  sendPrompt: (sessionId: string, text: string, fileContext: string) => Promise<void>;
}) {
  const references: string[] = [];
  for (const file of input.files) {
    let reference = input.pending.uploads.get(file);
    if (!reference) {
      reference = await uploadWorkspaceAttachment(input.client, input.workspaceId, file);
      input.pending.uploads.set(file, reference);
    }
    references.push(reference);
  }
  if (!input.pending.sessionId) {
    input.pending.sessionId = (await input.createSession()).id;
  }
  await input.sendPrompt(
    input.pending.sessionId,
    [input.text.trim(), ...references.map(workspaceAttachmentDisplayText)].filter(Boolean).join("\n\n"),
    references.map(workspaceAttachmentInstruction).join("\n\n"),
  );
  return input.pending.sessionId;
}
