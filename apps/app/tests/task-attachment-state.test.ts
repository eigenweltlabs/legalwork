import { afterEach, expect, test } from "bun:test";
import { createTaskAttachmentState } from "../src/react-app/domains/tasks/task-attachment-state";
import { artifactDocumentKey, getDocumentDiscardPrompt, registerUnsavedDocument, resolveDocumentDiscardPrompt } from "../src/react-app/domains/session/artifacts/docx-document-state";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); resolveDocumentDiscardPrompt(false); });
const tab = { id: "attachment", type: "artifact", label: "draft.docx", value: "draft.docx", preview: "word" } satisfies import("../src/react-app/domains/session/panel/panel-tab-store").ArtifactPanelTab;
function fixture(scope = "project-tasks") {
  const state = createTaskAttachmentState("workspace", scope);
  const unsubscribe = state.subscribe(() => {});
  cleanup.push(unsubscribe);
  state.open({ taskId: "task", tab });
  return { state, unsubscribe, key: artifactDocumentKey("workspace", scope, tab.id) };
}

test("Back to task preserves a dirty attachment on Cancel and closes only after Discard", () => {
  const { state, key } = fixture();
  let discarded = 0, navigated = 0;
  cleanup.push(registerUnsavedDocument(key, tab.label, () => true, () => discarded++));
  state.closeThen(() => navigated++);
  expect(getDocumentDiscardPrompt()?.names).toEqual([tab.label]);
  resolveDocumentDiscardPrompt(false);
  expect(state.getSnapshot()?.tab).toBe(tab);
  expect(navigated).toBe(0); expect(discarded).toBe(0);
  state.closeThen(() => navigated++);
  resolveDocumentDiscardPrompt(true);
  expect(state.getSnapshot()).toBeNull();
  expect(navigated).toBe(1); expect(discarded).toBe(1);
});

test("replacing an attachment prompts for its edits without discarding another task surface", () => {
  const { state, key } = fixture();
  const other = fixture("global-tasks");
  cleanup.push(registerUnsavedDocument(key, "Project draft", () => true));
  cleanup.push(registerUnsavedDocument(other.key, "Global draft", () => true, () => { throw new Error("Wrong surface discarded"); }));
  const next = { taskId: "next-task", tab: { ...tab, id: "next" } };
  state.open(next);
  expect(getDocumentDiscardPrompt()?.names).toEqual(["Project draft"]);
  resolveDocumentDiscardPrompt(false);
  expect(state.getSnapshot()?.taskId).toBe("task");
  state.open(next); resolveDocumentDiscardPrompt(true);
  expect(state.getSnapshot()).toBe(next);
  expect(other.state.getSnapshot()?.taskId).toBe("task");
});

test("clean attachments close immediately and pending navigation cannot run after unmount", () => {
  const { state, key, unsubscribe } = fixture();
  state.closeThen(); expect(state.getSnapshot()).toBeNull();
  state.open({ taskId: "task", tab });
  const unregister = registerUnsavedDocument(key, tab.label, () => true);
  cleanup.push(unregister);
  let navigated = false;
  state.closeThen(() => { navigated = true; });
  unsubscribe(); unregister();
  resolveDocumentDiscardPrompt(true);
  expect(navigated).toBe(false);
});
