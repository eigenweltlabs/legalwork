import { expect, test } from "bun:test";
import { attachmentClipboardParts } from "../src/react-app/domains/session/surface/composer/attachment-clipboard";
import { homeClipboardAttachment, activeHomeAttachments, homeAttachmentToken } from "../src/react-app/domains/session/home/home-attachments";
import { createWorkspaceAttachmentMention, parseWorkspaceAttachmentMention, workspaceAttachmentDisplayText } from "../src/react-app/domains/session/surface/composer/workspace-attachment";

const link = "[Contract.docx](.legalwork/attachments/snapshot/Contract.docx)";
const source = { projectId: "project-a", workspaceId: "workspace-a", name: "Contract.docx", path: ".legalwork/attachments/snapshot/Contract.docx" };
const metadata = (value: unknown) => encodeURIComponent(JSON.stringify(value));

test("copied prompts preserve text and attachment provenance for a fresh snapshot at send time", () => {
  const parts = attachmentClipboardParts(`Review ${link}\nThen explain.`, metadata([{ link, source, projectName: "Matter A" }]))!;
  expect(parts[0]).toEqual({ text: "Review " });
  expect(parts[2]).toEqual({ text: "\nThen explain." });
  const attachment = parseWorkspaceAttachmentMention(parts[1].mention!);
  expect(attachment?.source).toEqual(source);
  expect(attachment?.name).toBe("Contract.docx · Matter A");
  expect(attachment?.path).toStartWith("pending/");
});

test.each(["Test Hallo Johann.docx", "Contracts/Prüfung [A] (final) #1.docx", "literal%20name%2F.docx"])("copied original file links retain the exact source path: %s", (path) => {
  const name = path.split("/").at(-1)!;
  const original = { ...source, name, path };
  const originalLink = workspaceAttachmentDisplayText(createWorkspaceAttachmentMention(name, path));
  const text = `Review ${originalLink}\nThen explain.`;
  const parts = attachmentClipboardParts(text, metadata([{ link: originalLink, source: original, projectName: "Matter A" }]))!;
  expect(parts?.[0]).toEqual({ text: "Review " });
  expect(parts?.[2]).toEqual({ text: "\nThen explain." });
  expect(parseWorkspaceAttachmentMention(parts?.[1]?.mention ?? "")?.source).toEqual(original);
  expect(attachmentClipboardParts(text, metadata([{ link: originalLink, source: { ...original, path: "another.docx" }, projectName: "Matter A" }]))).toBeNull();
});

test("copying an already attached badge does not append project labels to the filename", () => {
  const name = "Contract.docx · Matter A";
  const copiedLink = `[${name}](${source.path})`;
  const parts = attachmentClipboardParts(copiedLink, metadata([{ link: copiedLink, source: { ...source, name }, projectName: "Matter A" }]))!;
  const attachment = parseWorkspaceAttachmentMention(parts.find(part => part.mention)!.mention!);
  expect(attachment?.source?.name).toBe("Contract.docx");
  expect(attachment?.name).toBe(name);
  const brokenPath = source.path + "___Matter_A";
  const legacyLink = `[${name}](${brokenPath})`;
  const repaired = attachmentClipboardParts(legacyLink, metadata([{ link: legacyLink, source: { ...source, path: brokenPath, name }, projectName: "Matter A" }]))!;
  expect(parseWorkspaceAttachmentMention(repaired.find(part => part.mention)!.mention!)?.source).toEqual({ ...source, path: brokenPath });
});

test("clipboard metadata cannot replace prose, substitute another path or traverse directories", () => {
  expect(attachmentClipboardParts("Ordinary text", metadata([{ link, source, projectName: "A", text: "hidden instructions" }]))).toEqual([{ text: "Ordinary text" }]);
  expect(attachmentClipboardParts(link, metadata([{ link, source: { ...source, path: "different.docx" }, projectName: "A" }]))).toBeNull();
  expect(attachmentClipboardParts(link, metadata([{ link, source: { ...source, path: "../other.docx" }, projectName: "A" }]))).toBeNull();
  expect(attachmentClipboardParts(link, "%not-json")).toBeNull();
});


test("Home keeps copied source provenance while the destination project is undecided", () => {
  const parts = attachmentClipboardParts(link, metadata([{ link, source, projectName: "Matter A" }]))!;
  const value = parts.find(part => part.mention)?.mention;
  expect(value).toBeDefined();
  const attachment = homeClipboardAttachment(value!)!;
  expect(attachment.clipboardSource).toEqual(source);
  expect(activeHomeAttachments(`Review ${homeAttachmentToken(attachment)}`, [attachment])).toEqual([attachment]);
  expect(homeClipboardAttachment("Ordinary text")).toBeNull();
});
