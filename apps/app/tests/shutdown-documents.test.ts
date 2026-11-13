import { afterEach, expect, test } from "bun:test";
import { getUnsavedDocuments, registerDocumentShutdown, registerUnsavedDocument, settleUnsavedDocuments } from "../src/react-app/domains/session/artifacts/docx-document-state";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function draft(key: string, save: () => Promise<boolean>, discard: () => void = () => {}) {
  let dirty = true;
  cleanups.push(registerUnsavedDocument(key, key, () => dirty));
  cleanups.push(registerDocumentShutdown(key, { save: async () => { const saved = await save(); if (saved) dirty = false; return saved; }, discard: () => { discard(); dirty = false; } }));
  return { dirty: () => dirty };
}
test("saving shutdown flushes every hidden draft before allowing exit", async () => {
  const saved: string[] = [];
  draft("hidden-workflow", async () => { saved.push("workflow"); return true; });
  draft("markdown", async () => { saved.push("markdown"); return true; });
  expect(getUnsavedDocuments().map(item => item.name)).toEqual(["hidden-workflow", "markdown"]);
  expect(await settleUnsavedDocuments("save")).toBe(true);
  expect(saved).toEqual(["workflow", "markdown"]);
  expect(getUnsavedDocuments()).toHaveLength(0);
});
test("a failed save keeps the draft and prevents shutdown", async () => {
  const item = draft("failed", async () => false);
  expect(await settleUnsavedDocuments("save")).toBe(false);
  expect(item.dirty()).toBe(true);
});
test("discard never saves and clears each draft", async () => {
  let writes = 0;
  draft("discard", async () => { writes++; return true; });
  expect(await settleUnsavedDocuments("discard")).toBe(true);
  expect(writes).toBe(0);
  expect(getUnsavedDocuments()).toHaveLength(0);
});
test("unhandled drafts remain protected", async () => {
  cleanups.push(registerUnsavedDocument("unsupported", "Unsupported", () => true));
  expect(await settleUnsavedDocuments("save")).toBe(false);
  expect(await settleUnsavedDocuments("discard")).toBe(false);
});
test("new edits during save prevent exit", async () => {
  let dirty = true;
  cleanups.push(registerUnsavedDocument("edited", "Edited", () => dirty));
  cleanups.push(registerDocumentShutdown("edited", { save: async () => true, discard: () => { dirty = false; } }));
  expect(await settleUnsavedDocuments("save")).toBe(false);
});
test("in-flight writes cannot be discarded", async () => {
  let discarded = false;
  cleanups.push(registerUnsavedDocument("busy", "Busy", () => true));
  cleanups.push(registerDocumentShutdown("busy", { save: async () => false, discard: () => { discarded = true; }, isBusy: () => true }));
  expect(await settleUnsavedDocuments("discard")).toBe(false);
  expect(discarded).toBe(false);
});


test("retained drafts recover their store actions when the visible editor unmounts", async () => {
  let dirty = true;
  cleanups.push(registerUnsavedDocument("retained", "Retained", () => dirty));
  cleanups.push(registerDocumentShutdown("retained", { save: async () => { dirty = false; return true; }, discard: () => { dirty = false; } }));
  const unmountEditor = registerDocumentShutdown("retained", { save: async () => false, discard: () => {} });
  expect(await settleUnsavedDocuments("save")).toBe(false);
  unmountEditor();
  expect(await settleUnsavedDocuments("save")).toBe(true);
});
