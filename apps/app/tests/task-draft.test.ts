import { describe, expect, test } from "bun:test";
import { createTaskDraft } from "../src/react-app/domains/tasks/task-draft";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const task = { title: "Original", description: "Description" };

describe("inline task drafts", () => {
  test("switching task subscribers preserves unsent text and a failed blur save", async () => {
    const draft = createTaskDraft(task);
    const stop = draft.subscribe(() => {});
    draft.setTitle("Unsaved title");
    draft.setNote("Unsent note");
    const request = deferred<void>();
    const saving = draft.write(() => request.promise);
    stop(); // The task detail unmounts while another row is selected.
    expect(draft.getSnapshot().pendingWrites).toBe(1);
    request.reject(new Error("offline"));
    await expect(saving).rejects.toThrow("offline");
    const stopReturning = draft.subscribe(() => {});
    draft.reconcile(task);
    expect(draft.getSnapshot()).toMatchObject({ title: "Unsaved title", note: "Unsent note", pendingWrites: 0 });
    expect(draft.isDirty()).toBe(true);
    stopReturning();
  });

  test("background refetch updates pristine fields while retaining local edits", () => {
    const draft = createTaskDraft(task);
    draft.setDescription("My edit");
    draft.reconcile({ title: "Colleague title", description: "Colleague description" });
    expect(draft.getSnapshot()).toMatchObject({ title: "Colleague title", description: "My edit" });
    draft.reconcile({ title: "Colleague title", description: "My edit" });
    expect(draft.isDirty()).toBe(false);
    draft.reconcile({ title: "Latest", description: "Latest description" });
    expect(draft.getSnapshot()).toMatchObject({ title: "Latest", description: "Latest description" });
  });

  test("returning during note submission cannot send a duplicate", async () => {
    const draft = createTaskDraft(task);
    draft.setNote("Send once");
    const request = deferred<boolean>();
    let calls = 0;
    const submit = () => { calls++; return request.promise; };
    const first = draft.submitNote(submit);
    await draft.submitNote(submit);
    expect(calls).toBe(1);
    expect(draft.getSnapshot().savingNote).toBe(true);
    request.resolve(true);
    await first;
    expect(draft.getSnapshot()).toMatchObject({ note: "", savingNote: false });
    expect(draft.isDirty()).toBe(false);
  });

  test("note failure retains text and success cannot clear newer input", async () => {
    const draft = createTaskDraft(task);
    draft.setNote("First");
    await draft.submitNote(async () => false);
    expect(draft.getSnapshot().note).toBe("First");
    const request = deferred<boolean>();
    const saving = draft.submitNote(() => request.promise);
    draft.setNote("Newer text");
    request.resolve(true);
    await saving;
    expect(draft.getSnapshot().note).toBe("Newer text");
  });

  test("save completion retains edits typed after the submitted version", async () => {
    const draft = createTaskDraft(task);
    draft.setTitle("Submitted");
    const request = deferred<void>();
    const saving = draft.write(async () => {
      await request.promise;
      draft.reconcile({ ...task, title: "Submitted" });
    });
    draft.setTitle("Newer title");
    request.resolve();
    await saving;
    expect(draft.getSnapshot().title).toBe("Newer title");
    expect(draft.isDirty()).toBe(true);
  });

  test("overlapping requests remain pending until all complete", async () => {
    const draft = createTaskDraft(task);
    const first = deferred<void>();
    const second = deferred<void>();
    const saves = [draft.write(() => first.promise), draft.write(() => second.promise)];
    first.resolve();
    await saves[0];
    expect(draft.getSnapshot().pendingWrites).toBe(1);
    expect(draft.isDirty()).toBe(true);
    second.resolve();
    await saves[1];
    expect(draft.isDirty()).toBe(false);
  });
});
