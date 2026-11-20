import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { createLauncherDocument, documentBytes } from "./launcher-document.js";

test("document creation saves exactly once, keeps collisions and rejects retargeted retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-document-"));
  const input = { operationId: "document_123", folder: "Contracts/Drafts", name: "Contract", format: "md" as const, text: "Original" };
  let approvals = 0;
  try {
    const save = () => createLauncherDocument(root, input, async () => { approvals++; });
    expect(await Promise.all([save(), save()])).toEqual([{ path: "Contracts/Drafts/Contract.md" }, { path: "Contracts/Drafts/Contract.md" }]);
    expect(approvals).toBe(1);
    expect(await readFile(join(root, "Contracts/Drafts/Contract.md"), "utf8")).toBe("Original");
    await expect(createLauncherDocument(root, { ...input, text: "changed" }, async () => {})).rejects.toThrow("different document");
    await expect(createLauncherDocument(root, { ...input, operationId: "document_456", text: "replace" }, async () => {})).rejects.toThrow("already exists");
    expect(await readFile(join(root, "Contracts/Drafts/Contract.md"), "utf8")).toBe("Original");
    // A pending receipt from a process crash can recover the already written bytes.
    const receipt = join(root, ".legalwork/launcher-documents/document_123.json");
    const pending = JSON.parse(await readFile(receipt, "utf8")); pending.complete = false;
    await writeFile(receipt, JSON.stringify(pending));
    expect(await save()).toEqual({ path: "Contracts/Drafts/Contract.md" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creation rechecks paths after approval and rejects linked templates and receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-doc-path-"));
  const outside = await mkdtemp(join(tmpdir(), "launcher-doc-outside-"));
  const input = { operationId: "safe_document", folder: "folder", name: "Contract", format: "txt" as const, text: "content" };
  try {
    await expect(createLauncherDocument(root, { ...input, folder: "../outside" }, async () => {})).rejects.toThrow("inside");
    await mkdir(join(root, "folder"));
    await expect(createLauncherDocument(root, input, async () => { await rm(join(root, "folder"), { recursive: true }); await symlink(outside, join(root, "folder")); })).rejects.toThrow("linked folder");
    expect(await readFile(join(outside, "Contract.txt"), "utf8").catch(() => null)).toBeNull();
    await writeFile(join(outside, "template.txt"), "template");
    await symlink(join(outside, "template.txt"), join(root, "template.txt"));
    await expect(createLauncherDocument(root, { ...input, folder: "", templatePath: "template.txt" }, async () => {})).rejects.toThrow("regular template");
    await symlink(join(outside, "template.txt"), join(root, ".legalwork/launcher-documents/safe_document.json"));
    await expect(createLauncherDocument(root, { ...input, folder: "" }, async () => {})).rejects.toThrow("receipt");
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
});

test("Word output is deterministic OOXML and templates preserve original bytes", async () => {
  const bytes = documentBytes("docx", "§1 <Terms> & conditions\nSecond line");
  expect(bytes).toEqual(documentBytes("docx", "§1 <Terms> & conditions\nSecond line"));
  const archive = unzipSync(bytes);
  expect(Object.keys(archive)).toContain("[Content_Types].xml");
  expect(strFromU8(archive["word/document.xml"])).toContain("§1 &lt;Terms&gt; &amp; conditions");
  const root = await mkdtemp(join(tmpdir(), "launcher-template-"));
  try {
    await writeFile(join(root, "template.docx"), bytes);
    await createLauncherDocument(root, { operationId: "template_copy", folder: "", name: "Copy", format: "docx", text: "", templatePath: "template.docx" }, async () => {});
    expect(Buffer.from(await readFile(join(root, "Copy.docx"))).equals(Buffer.from(bytes))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
