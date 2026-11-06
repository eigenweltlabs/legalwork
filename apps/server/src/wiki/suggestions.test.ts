import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WikiSuggestions } from "./suggestions.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wiki-suggestion-")); roots.push(root);
  return { root, store: new WikiSuggestions(root, "project") };
}
const input = { title: "Research", content: "# Research\n\nUseful finding.", destination: { wikiId: "wiki", path: "Research.md", baseRevision: null } };
test("staged links distinguish a new source from a published file with the same name", async () => {
  const { root, store } = await fixture();
  await writeFile(join(root, "judgment.pdf"), "New judgment");
  const content = "# Research\n\n## Source files\n\n- [Earlier judgment](Sources/judgment.pdf)\n";
  const draft = await store.create({ ...input, content, attachments: [{ sourcePath: "judgment.pdf" }] }, null);
  expect(draft.content).toContain("[Earlier judgment](Sources/judgment.pdf)");
  expect(draft.content).toContain(`Sources/${draft.id}/judgment.pdf`);
  const removed = await store.update(draft.id, draft.revision, { ...draft, attachments: [] });
  expect(removed.content).toBe(content);
});
test("ordinary Markdown drafts survive reopening and detect external agent edits", async () => {
  const { root, store } = await fixture();
  expect(await store.list()).toEqual([]);
  const draft = await store.create(input, "chat");
  const reopened = new WikiSuggestions(root, "project");
  expect(await reopened.read(draft.id)).toEqual(draft);
  await writeFile(join(root, draft.filePath), "# Agent edit");
  expect((await reopened.read(draft.id)).content).toBe("# Agent edit");
  await expect(reopened.update(draft.id, draft.revision, input)).rejects.toThrow("This draft changed");
  expect(await readFile(join(root, draft.filePath), "utf8")).toBe("# Agent edit");
});
test("proposal folders and files cannot be redirected through symlinks", async () => {
  const { root, store } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "wiki-suggestion-outside-")); roots.push(outside);
  await mkdir(join(root, ".legalwork"));
  await symlink(outside, join(root, ".legalwork/tmp"));
  await expect(store.create(input, null)).rejects.toThrow("without symbolic links");
  await rm(join(root, ".legalwork/tmp"));
  const draft = await store.create(input, null);
  await rm(join(root, draft.filePath));
  await writeFile(join(outside, "secret.md"), "secret");
  await symlink(join(outside, "secret.md"), join(root, draft.filePath));
  await expect(store.read(draft.id)).rejects.toThrow("without symbolic links");
  await expect(store.read("../../secret")).rejects.toThrow("Choose a wiki suggestion");
});

test("source snapshots survive original edits and removal, and changing destination updates portable links", async () => {
  const { root, store } = await fixture();
  const original = Buffer.from("%PDF-1.4\nOriginal judgment\n");
  await writeFile(join(root, "judgment.pdf"), original);
  const draft = await store.create({ ...input, attachments: [{ sourcePath: "judgment.pdf", name: "Court (2026).pdf" }] }, null);
  expect(draft.attachments).toHaveLength(1);
  expect(await readFile(join(root, draft.attachments[0]!.filePath))).toEqual(original);
  expect(draft.content).toContain(`Sources/${draft.id}/Court%20%282026%29.pdf`);
  await writeFile(join(root, "judgment.pdf"), "Changed download");
  const moved = await store.update(draft.id, draft.revision, { ...draft, destination: { ...draft.destination, path: "EU/Privacy/Finding.md" } });
  await rm(join(root, "judgment.pdf"));
  expect(moved.content).toContain(`../../Sources/${draft.id}/Court%20%282026%29.pdf`);
  expect((moved.content.match(/## Source files/g) ?? [])).toHaveLength(1);
  expect((await store.attachment(moved, 0)).data).toEqual(original);
  expect((await new WikiSuggestions(root, "project").read(draft.id)).attachments).toEqual(moved.attachments);
  const removed = await store.update(moved.id, moved.revision, { ...moved, attachments: [] });
  expect(removed.content).toBe(input.content);
  expect(removed.attachments).toEqual([]);
  await expect(store.current(removed.id, moved.revision)).rejects.toMatchObject({ code: "suggestion_changed" });
});

test("changed or symlinked staged sources cannot be previewed or published", async () => {
  const { root, store } = await fixture();
  await writeFile(join(root, "judgment.pdf"), "Original");
  const draft = await store.create({ ...input, attachments: [{ sourcePath: "judgment.pdf" }] }, null);
  const staged = join(root, draft.attachments[0]!.filePath);
  await writeFile(staged, "Tampered");
  await expect(store.attachment(draft, 0)).rejects.toMatchObject({ code: "suggestion_attachment_changed" });
  await rm(staged);
  await symlink(join(root, "judgment.pdf"), staged);
  await expect(store.attachment(draft, 0)).rejects.toThrow("without symbolic links");
});

test("source staging rejects escapes, active files, duplicate names and oversized downloads without leaving broken drafts", async () => {
  const { root, store } = await fixture();
  await writeFile(join(root, "source.pdf"), "PDF");
  await symlink(join(root, "source.pdf"), join(root, "link.pdf"));
  await mkdir(join(root, "downloads"));
  await symlink(join(root, "downloads"), join(root, "linked"));
  await writeFile(join(root, "downloads/source.pdf"), "PDF");
  for (const sourcePath of ["../source.pdf", join(root, "source.pdf"), "link.pdf", "linked/source.pdf", "source.html", ".env", "downloads"]) {
    await expect(store.create({ ...input, attachments: [{ sourcePath }] }, null)).rejects.toBeDefined();
    expect(await store.list()).toEqual([]);
  }
  await expect(store.create({ ...input, attachments: [{ sourcePath: "source.pdf", name: "../escape.pdf" }] }, null)).rejects.toBeDefined();
  await expect(store.create({ ...input, attachments: [{ sourcePath: "source.pdf" }, { sourcePath: "downloads/source.pdf", name: "SOURCE.pdf" }] }, null)).rejects.toMatchObject({ code: "duplicate_suggestion_attachment" });
  await truncate(join(root, "source.pdf"), 100 * 1024 * 1024 + 1);
  await expect(store.create({ ...input, attachments: [{ sourcePath: "source.pdf" }] }, null)).rejects.toMatchObject({ code: "suggestion_attachments_too_large" });
  expect(await store.list()).toEqual([]);
});
