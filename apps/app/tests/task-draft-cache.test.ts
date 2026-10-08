import { describe, expect, test } from "bun:test";
import { getTaskDraft, hasTaskDrafts, retainTaskDraftScope, taskDraftScope } from "../src/react-app/domains/tasks/task-draft-cache";
import { artifactDocumentKey, confirmDiscardDocuments, hasUnsavedSessionDocument } from "../src/react-app/domains/session/artifacts/docx-document-state";

const task = { id: "task", title: "Original", description: "Description" };
const scopeFor = (name: string) => taskDraftScope(`https://${name}.example`, "workspace", "project", false);
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("task draft route lifetime", () => {
  test("unsent note survives route unmount and remains registered", async () => {
    const scope = scopeFor("leave-return");
    const release = retainTaskDraftScope(scope);
    const draft = getTaskDraft(scope, "workspace", task);
    draft.setNote("Unsent");
    release();
    await tick();
    expect(hasTaskDrafts()).toBe(true);
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(true);
    const releaseReturn = retainTaskDraftScope(scope);
    expect(getTaskDraft(scope, "workspace", task)).toBe(draft);
    expect(draft.getSnapshot().note).toBe("Unsent");
    expect(confirmDiscardDocuments(undefined, () => { throw new Error("An unrelated panel must not ask to discard this draft"); })).toBe(true);
    expect(draft.getSnapshot().note).toBe("Unsent");
    expect(confirmDiscardDocuments(artifactDocumentKey("workspace", scope, "task:task"), () => true)).toBe(true);
    expect(draft.getSnapshot().note).toBe("");
    releaseReturn();
    await tick();
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(false);
  });

  test("clean entries release after real unmount, but survive StrictMode and concurrent mounts", async () => {
    const scope = scopeFor("strict");
    const first = retainTaskDraftScope(scope);
    const draft = getTaskDraft(scope, "workspace", task);
    first();
    const second = retainTaskDraftScope(scope);
    const concurrent = retainTaskDraftScope(scope);
    await tick();
    expect(getTaskDraft(scope, "workspace", task)).toBe(draft);
    second();
    await tick();
    expect(getTaskDraft(scope, "workspace", task)).toBe(draft);
    concurrent();
    await tick();
    const last = retainTaskDraftScope(scope);
    expect(getTaskDraft(scope, "workspace", task)).not.toBe(draft);
    last();
    await tick();
  });

  test("server, project and embedded scopes cannot share drafts", async () => {
    const scopes = [scopeFor("one"), scopeFor("two"), taskDraftScope("https://one.example", "workspace", "other", false), taskDraftScope("https://one.example", "workspace", "project", true)];
    const releases = scopes.map(retainTaskDraftScope);
    const drafts = scopes.map(scope => getTaskDraft(scope, "workspace", task));
    drafts[0].setNote("Private to scope one");
    expect(drafts.slice(1).every(draft => draft.getSnapshot().note === "")).toBe(true);
    drafts[0].discard();
    releases.forEach(release => release());
    await tick();
  });

  test("a successful write finishing while hidden clears its registration", async () => {
    const scope = scopeFor("hidden-save");
    const release = retainTaskDraftScope(scope);
    const draft = getTaskDraft(scope, "workspace", task);
    draft.setTitle("Saved");
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const write = draft.write(async () => { await pending; draft.reconcile({ ...task, title: "Saved" }); });
    release();
    await tick();
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(true);
    finish();
    await write;
    await tick();
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(false);
    expect(draft.isDirty()).toBe(false);
  });

  test("uploads remain protected and cannot duplicate after leaving and returning", async () => {
    const scope = scopeFor("upload");
    const release = retainTaskDraftScope(scope);
    const draft = getTaskDraft(scope, "workspace", task);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    const operation = () => { calls++; return pending; };
    const upload = draft.upload(operation);
    release();
    await tick();
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(true);
    expect(getTaskDraft(scope, "workspace", task).getSnapshot().uploading).toBe(true);
    await draft.upload(operation);
    expect(calls).toBe(1);
    finish();
    await upload;
    await tick();
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(false);
  });

  test("a failed write finishing while hidden keeps the draft for return", async () => {
    const scope = scopeFor("hidden-failure");
    const release = retainTaskDraftScope(scope);
    const draft = getTaskDraft(scope, "workspace", task);
    draft.setDescription("Failed edit");
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    const write = draft.write(() => pending);
    release();
    fail(new Error("offline"));
    await expect(write).rejects.toThrow("offline");
    await tick();
    expect(getTaskDraft(scope, "workspace", task)).toBe(draft);
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(true);
    draft.discard();
    await tick();
    expect(hasUnsavedSessionDocument(scope, "task:task")).toBe(false);
    expect(hasTaskDrafts()).toBe(false);
  });
});
