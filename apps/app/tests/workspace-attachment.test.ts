import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import {
  createWorkspaceAttachmentMention,
  parseWorkspaceAttachmentMention,
  parseWorkspaceAttachmentLink,
  WORKSPACE_ATTACHMENT_LINK_SOURCE,
  uploadWorkspaceAttachment,
  uploadWorkspaceFileAttachment,
  workspaceAttachmentDisplayText,
  workspaceAttachmentInstruction,
} from "../src/react-app/domains/session/surface/composer/workspace-attachment";
import { decodeComposerMentionValue, encodeComposerMentionValue } from "../src/react-app/domains/session/surface/composer/mention-encoding";
import { buildComposerDraft } from "../src/react-app/domains/session/surface/composer/composer-draft";

describe("workspace attachments", () => {
  test("file mentions save a server-side snapshot and send only its reading reference", async () => {
    const path = "Contracts/Prüfung (final).pdf";
    let uploads = 0;
    const reference = await uploadWorkspaceFileAttachment({
      copyWorkspaceFile: async (workspace, requestedPath, targetPath) => {
        expect(workspace).toBe("ws-test"); expect(requestedPath).toBe(path);
        uploads++;
        expect(targetPath).toStartWith(".legalwork/attachments/"); expect(targetPath).not.toBe(path);
        return { ok: true, path: targetPath };
      },
    }, "ws-test", path);
    expect(uploads).toBe(1);
    expect(parseWorkspaceAttachmentMention(reference)?.name).toBe("Prüfung (final).pdf");
    const draft = buildComposerDraft(`Read @${encodeComposerMentionValue(reference)} `, [], { [reference]: "upload" }, []);
    expect(draft.parts.every(part => part.type === "text")).toBe(true);
    expect(draft.attachments).toEqual([]);
    expect(draft.modelContext).toBe(workspaceAttachmentInstruction(reference));
    expect(draft.modelContext).toContain("Read this file with tools appropriate for its format");
  });

  test("failed mention copies do not produce an attachment or upload unreadable sources", async () => {
    await expect(uploadWorkspaceFileAttachment({
      copyWorkspaceFile: async () => { throw new Error("Source unavailable"); },
    }, "ws-test", "missing.pdf")).rejects.toThrow("Source unavailable");
  });

  test("local project references preserve original paths with spaces, Unicode and parentheses", () => {
    const path = "Notes/Prüfung [A] (final) #1.md";
    const mention = createWorkspaceAttachmentMention("Prüfung [A]", path);
    const decoded = decodeComposerMentionValue(encodeComposerMentionValue(mention));
    expect(parseWorkspaceAttachmentMention(decoded)).toEqual({ name: "Prüfung [A]", path });
    const tokens = marked.Lexer.lexInline(workspaceAttachmentDisplayText(decoded));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.type).toBe("link");
    if (tokens[0]?.type === "link") expect(decodeURIComponent(tokens[0].href)).toBe(path);
    expect(workspaceAttachmentInstruction(decoded)).toContain(JSON.stringify(path));
  });
  for (const [name, type] of [
    ["contract.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["schedule.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["scan.pdf", "application/pdf"],
    ["photo.png", "image/png"],
    ["unknown.bin", ""],
  ]) {
    test(`${name} uploads unchanged bytes and becomes a path reference`, async () => {
      const bytes = new Uint8Array([0, 80, 75, 255, 128, 10]);
      const file = new File([bytes], name, { type });
      const mention = await uploadWorkspaceAttachment({
        writeWorkspaceBinaryFile: async (workspace, payload) => {
          expect(workspace).toBe("ws-test");
          expect(payload.data).toBe(file);
          if (!("arrayBuffer" in payload.data)) throw new Error("Expected streamed file");
          expect(new Uint8Array(await payload.data.arrayBuffer())).toEqual(bytes);
          return { ok: true, path: payload.path, bytes: payload.data.size, updatedAt: 0 };
        },
      }, "ws-test", file);
      const attachment = parseWorkspaceAttachmentMention(mention);
      expect(attachment?.name).toBe(name);
      expect(attachment?.path).toStartWith(".legalwork/attachments/");
      expect(attachment?.path).toEndWith(`/${name}`);
      const visible = workspaceAttachmentDisplayText(mention);
      expect(visible).toBe(`[${name}](${attachment?.path})`);
      expect(visible).not.toContain("Read this file");
      expect(parseWorkspaceAttachmentLink(visible)).toEqual(attachment);
      expect(visible.split(new RegExp(`(${WORKSPACE_ATTACHMENT_LINK_SOURCE})`))).toEqual(["", visible, ""]);
      expect(workspaceAttachmentInstruction(mention)).toContain(attachment?.path ?? "missing");
      expect(mention).not.toContain("data:");
    });
  }

  test("same-named uploads have distinct paths; special filenames remain one safe badge", async () => {
    const file = new File(["content"], "Anlage [A] @50% #1 (Müller).docx");
    const client = { writeWorkspaceBinaryFile: async (_workspace: string, payload: { path: string; data: ArrayBuffer | Blob }) => ({
      ok: true, path: payload.path, bytes: "size" in payload.data ? payload.data.size : payload.data.byteLength, updatedAt: 0,
    }) };
    const first = await uploadWorkspaceAttachment(client, "ws-test", file);
    const second = await uploadWorkspaceAttachment(client, "ws-test", file);
    expect(parseWorkspaceAttachmentMention(first)?.path).not.toBe(parseWorkspaceAttachmentMention(second)?.path);
    expect(parseWorkspaceAttachmentMention(decodeComposerMentionValue(encodeComposerMentionValue(first)))?.name).toBe(file.name);
    expect(encodeComposerMentionValue(first)).not.toMatch(/[\s@]/);
    expect(parseWorkspaceAttachmentLink(workspaceAttachmentDisplayText(first))?.name).toBe(file.name);
    const tokens = marked.Lexer.lexInline(workspaceAttachmentDisplayText(first));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.type).toBe("link");
    if (tokens[0]?.type === "link") expect(tokens[0].href).toBe(parseWorkspaceAttachmentMention(first)?.path);
  });

  test("drop uploads pass the file without materializing a full ArrayBuffer", async () => {
    const file = new File(["source bytes"], "large.pdf");
    file.arrayBuffer = async () => { throw new Error("Must stream the file instead"); };
    const mention = await uploadWorkspaceAttachment({ writeWorkspaceBinaryFile: async (_workspace, payload) => {
      expect(payload.data).toBe(file);
      return { ok: true, path: payload.path, bytes: file.size, updatedAt: 0 };
    } }, "ws-test", file);
    expect(parseWorkspaceAttachmentMention(mention)?.name).toBe("large.pdf");
  });

  test("upload failures never produce a usable reference", async () => {
    const file = new File(["content"], "contract.docx");
    await expect(uploadWorkspaceAttachment({ writeWorkspaceBinaryFile: async () => {
      throw new Error("Server unavailable");
    } }, "ws-test", file)).rejects.toThrow("Server unavailable");
    await expect(uploadWorkspaceAttachment({ writeWorkspaceBinaryFile: async () => ({ ok: false, path: "", bytes: 0, updatedAt: 0 }) }, "ws-test", file)).rejects.toThrow("did not complete");
    expect(parseWorkspaceAttachmentMention("attachment://workspace?name=contract.docx")).toBeNull();
  });
});
