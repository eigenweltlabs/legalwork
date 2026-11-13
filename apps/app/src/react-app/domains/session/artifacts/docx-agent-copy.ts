import { docxCompareSchema, docxInspectSchema } from "@legalwork/types/office-editor";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { DocxEditorApi, DocxEditorToolResult } from "./artifact-docx-editor";
import { checkDocumentTask, type DocumentTaskOptions } from "./document-task-queue";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reads/writes use the originating project's server, including remote projects,
 * permission checks and create-only writes. Never write through the local fs. */
export async function executeWordCopy(
  api: Pick<DocxEditorApi, "executeAgentTool">,
  client: Pick<LegalworkServerClient, "downloadWorkspaceFile" | "writeWorkspaceBinaryFile">,
  workspaceId: string,
  toolName: "create_comparison_copy" | "create_clean_copy",
  rawArgs: Record<string, unknown>,
  options: DocumentTaskOptions = {},
): Promise<DocxEditorToolResult> {
  checkDocumentTask(options);
  const args = toolName === "create_comparison_copy" ? docxCompareSchema.parse(rawArgs) : docxInspectSchema.parse(rawArgs);
  if (!args.fileName) throw new Error("Choose a new filename for the outgoing copy.");
  let nativeArgs: Record<string, unknown> = args;
  if ("versions" in args) {
    const versions = [];
    for (const version of args.versions) {
      checkDocumentTask(options);
      const saved = await client.downloadWorkspaceFile(workspaceId, version.path);
      if (saved.data.byteLength > 25_000_000) throw new Error("Returned drafts must be at most 25 MB.");
      const bytes = new Uint8Array(saved.data); let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      versions.push({ base64: btoa(binary), author: version.author });
    }
    nativeArgs = { ...args, versions };
  }
  const result = await api.executeAgentTool(toolName, nativeArgs, options);
  if (!result.success) return result;
  if (!record(result.data) || typeof result.data.bufferBase64 !== "string" || result.data.bufferBase64.length > 50_000_000) throw new Error("The editor did not return a valid Word copy.");
  const { bufferBase64, ...data } = result.data;
  const buffer = Uint8Array.from(atob(bufferBase64), char => char.charCodeAt(0)).buffer;
  checkDocumentTask(options);
  const written = await client.writeWorkspaceBinaryFile(workspaceId, { path: args.fileName, data: buffer, createOnly: true });
  return { success: true, saved: true, data: { ...data, path: written.path, sourceChanged: false } };
}
