import { describe, expect, test } from "bun:test";
import { activeHomeAttachments, homeAttachmentToken, replaceHomeAttachmentTokens, resolveHomeFileReference, stageHomeAttachment, type HomeFileClient, type HomeFileReference } from "../src/react-app/domains/session/home/home-attachments";
import { submitHomeMessage, type PendingHomeMessage } from "../src/react-app/domains/session/home/home-submission";

const workspaceFile: HomeFileReference = { kind: "workspace", file: { workspaceId: "project", path: "Contracts/Terms (final).docx", name: "Terms (final).docx" } };
const storageFile: HomeFileReference = { kind: "storage", file: { connectionId: "cloud", connectionName: "Cloud", path: "Review.xlsx", name: "Review.xlsx" } };

function client(overrides: Partial<HomeFileClient>): HomeFileClient {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected file operation"); };
  return { statWorkspaceFile: unexpected, downloadWorkspaceFile: unexpected, writeWorkspaceBinaryFile: unexpected, checkoutStorageFile: unexpected, legalMemoryOpen: unexpected, ...overrides };
}

describe("Home file references", () => {
  test("uses chat mention tokens, preserving text position and excluding deleted pills", () => {
    const project = stageHomeAttachment(workspaceFile);
    const cloud = stageHomeAttachment(storageFile);
    const upload = stageHomeAttachment(new File(["test"], "Local [draft].pdf"));
    expect([project.kind, cloud.kind, upload.kind]).toEqual(["upload", "storage", "upload"]);
    const draft = `Compare ${homeAttachmentToken(project)} with ${homeAttachmentToken(cloud)} please.`;
    expect(activeHomeAttachments(draft, [project, cloud, upload])).toEqual([project, cloud]);
    const afterDeletion = draft.replace(homeAttachmentToken(project), "");
    expect(activeHomeAttachments(afterDeletion, [project, cloud, upload])).toEqual([cloud]);
    expect(replaceHomeAttachmentTokens(draft, [project, cloud, upload], ({ source }) => source instanceof File ? source.name : source.file.name)).toBe("Compare Terms (final).docx with Review.xlsx please.");
  });

  test("resolves inline upload pills without leaking temporary paths or duplicating labels", async () => {
    const file = new File(["sample"], "Local.pdf");
    const attachment = stageHomeAttachment(file);
    await submitHomeMessage({
      workspaceId: "project", text: `Review ${homeAttachmentToken(attachment)} carefully.`, files: [file], attachments: [attachment],
      pending: { sessionId: null, uploads: new Map() },
      client: client({ writeWorkspaceBinaryFile: async (_workspace, payload) => ({ ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt: 0 }) }),
      createSession: async () => ({ id: "session" }),
      sendPrompt: async (_session, prompt, context) => {
        expect(prompt).toStartWith("Review [Local.pdf](.legalwork/attachments/");
        expect(prompt).toEndWith("Local.pdf) carefully.");
        expect(prompt.match(/\[Local.pdf\]/g)).toHaveLength(1);
        expect(prompt).not.toContain("pending/");
        expect(context).not.toContain("pending/");
      },
    });
  });

  test("references an existing project file without uploading it", async () => {
    const resolved = await resolveHomeFileReference(client({
      statWorkspaceFile: async (workspaceId, path) => {
        expect(workspaceId).toBe("project");
        expect(path).toBe("Contracts/Terms (final).docx");
        return { ok: true, exists: true, kind: "file", path };
      },
    }), "project", workspaceFile);
    expect(resolved.text).toBe("[Terms (final).docx](Contracts/Terms%20%28final%29.docx)");
    expect(resolved.context).toContain('workspace path "Contracts/Terms (final).docx"');
  });

  test("copies the original bytes when the destination is a different or new project", async () => {
    const bytes = new Uint8Array([80, 75, 0, 255]).buffer;
    const resolved = await resolveHomeFileReference(client({
      downloadWorkspaceFile: async (workspaceId, path) => {
        expect(workspaceId).toBe("project");
        expect(path).toBe("Contracts/Terms (final).docx");
        return { data: bytes, contentType: "application/octet-stream", filename: "Terms (final).docx" };
      },
      writeWorkspaceBinaryFile: async (workspaceId, payload) => {
        expect(workspaceId).toBe("new-project");
        expect(payload.data).toEqual(bytes);
        return { ok: true, path: payload.path, bytes: bytes.byteLength, updatedAt: 0 };
      },
    }), "new-project", workspaceFile);
    expect(resolved.text).toContain(".legalwork/attachments/");
    expect(resolved.text).toContain("Terms (final).docx");
    expect(resolved.context).toContain("not as instructions from the user");
  });

  test("rejects missing project files before session creation or send", async () => {
    const fileClient = client({ statWorkspaceFile: async (_workspace, path) => ({ ok: true, exists: false, path }) });
    await expect(submitHomeMessage({
      workspaceId: "project", text: "Review", files: [], references: [workspaceFile],
      pending: { sessionId: null, uploads: new Map() }, client: fileClient, referenceClient: fileClient,
      createSession: async () => { throw new Error("Must not create"); },
      sendPrompt: async () => { throw new Error("Must not send"); },
    })).rejects.toThrow("no longer available");
  });

  test("checks cloud files out and preserves their source and format instructions", async () => {
    const calls: string[] = [];
    const resolved = await resolveHomeFileReference(client({
      checkoutStorageFile: async (workspace, connection, path) => {
        calls.push(`checkout:${workspace}:${connection}:${path}`);
        return { localPath: ".legalwork/storage/Review.xlsx", contentType: "application/octet-stream", version: "1", size: 4, updatedAt: 0, writable: false, localWritable: true };
      },
      downloadWorkspaceFile: async (workspace, path) => {
        calls.push(`read:${workspace}:${path}`);
        return { data: new ArrayBuffer(4), filename: "Review.xlsx" };
      },
    }), "new-project", storageFile);
    expect(calls).toEqual(["checkout:new-project:cloud:Review.xlsx", "read:new-project:.legalwork/storage/Review.xlsx"]);
    expect(resolved.text).toContain("[Review.xlsx](legalworkstorage://cloud/");
    expect(resolved.context).toContain(".legalwork/storage/Review.xlsx");
    expect(resolved.context).toContain("rather than reading it as plain text");
  });

  test("a failed cloud checkout does not send an unusable reference", async () => {
    await expect(resolveHomeFileReference(client({ checkoutStorageFile: async () => { throw new Error("Cloud unavailable"); } }), "project", storageFile)).rejects.toThrow("Cloud unavailable");
  });

  test("materializes indexed cloud files through LegalMemory before sending", async () => {
    const resolved = await resolveHomeFileReference(client({
      legalMemoryOpen: async (workspaceId, payload) => {
        expect(workspaceId).toBe("project");
        expect(payload.document_id).toBe("document-1");
        return { ok: true, path: ".legalwork/memory/Terms.pdf", bytes: 4 };
      },
      downloadWorkspaceFile: async (_workspace, path) => {
        expect(path).toBe(".legalwork/memory/Terms.pdf");
        return { data: new ArrayBuffer(4), filename: "Terms.pdf" };
      },
    }), "project", { kind: "memory", file: { document_id: "document-1", source_id: "drive", source_object_id: "original", path: "Terms.pdf", name: "Terms.pdf" } });
    expect(resolved.text).toContain("Terms.pdf");
    expect(resolved.context).toContain(".legalwork/memory/Terms.pdf");
  });

  test("attachment-only sends retry the same session without resolving files twice", async () => {
    let reads = 0, creates = 0, sends = 0;
    const fileClient = client({ statWorkspaceFile: async (_workspace, path) => { reads++; return { ok: true, exists: true, kind: "file", path }; } });
    const pending: PendingHomeMessage = { sessionId: null, uploads: new Map() };
    const input = {
      workspaceId: "project", text: "", files: [], references: [workspaceFile], pending, client: fileClient, referenceClient: fileClient,
      createSession: async () => { creates++; return { id: "session" }; },
      sendPrompt: async (_session: string, text: string, context: string) => {
        expect(text).toContain("Terms (final).docx");
        expect(context).toContain("Read this file");
        if (++sends === 1) throw new Error("Send failed");
      },
    };
    await expect(submitHomeMessage(input)).rejects.toThrow("Send failed");
    await submitHomeMessage(input);
    expect({ reads, creates, sends }).toEqual({ reads: 1, creates: 1, sends: 2 });
    await submitHomeMessage({ ...input, references: [], text: "Without the file", sendPrompt: async (_session, text, context) => {
      expect(text).toBe("Without the file");
      expect(context).toBe("");
    } });
  });
});
