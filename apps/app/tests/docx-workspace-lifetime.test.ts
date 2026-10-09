import { expect, test } from "bun:test";
import { createDocumentAutosave } from "../src/react-app/domains/session/artifacts/document-autosave";
import { artifactDocumentKey, getDocumentDiscardPrompt, publishedDocxSnapshot, reconcileDocxSnapshot, registerUnsavedDocument, resolveDocumentDiscardPrompt, savedDocxSnapshot, type DocxSnapshot } from "../src/react-app/domains/session/artifacts/docx-document-state";
import { createPanelTabStore, type ArtifactPanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";

test("moving a focused dirty DOCX keeps its pending save; closing cancels safely and reopening sees saved bytes", async () => {
  const panels = createPanelTabStore();
  const scope = "workspace:docx-lifetime";
  const tab: ArtifactPanelTab = { id: "document", type: "artifact", label: "Document.docx", value: "Document.docx", preview: "word" };
  panels.getState().openTab(scope, tab);
  panels.getState().openTab(scope, { id: "chat", type: "chat", sessionId: "chat", label: "Chat" }, "main", "right");
  const other = panels.getState().sessions[scope].panes.find(pane => pane.id !== "main")!;
  panels.getState().selectTab(scope, tab.id);
  let dirty = true, saves = 0;
  let finish = () => {};
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const draft = new Uint8Array([2, 4, 6]).buffer;
  const loaded: DocxSnapshot = { kind: "binary", data: new Uint8Array([1]).buffer, updatedAt: 1, revision: 1, contentType: null };
  let published = loaded;
  const release = registerUnsavedDocument(artifactDocumentKey("project", scope, tab.id), tab.label, () => dirty);
  const autosave = createDocumentAutosave({ delay: 10000, isDirty: () => dirty, onError: error => { throw error; }, save: async () => {
    saves++; await pending;
    published = publishedDocxSnapshot(savedDocxSnapshot(loaded, draft, 2), 2);
    dirty = false; return true;
  } });
  try {
    autosave.setEnabled(true);
    const saving = autosave.flush();
    expect(saves).toBe(1);
    panels.getState().moveTab(scope, tab.id, other.id);
    expect(panels.getState().sessions[scope].focusedPaneId).toBe(other.id);
    expect(panels.getState().sessions[scope].tabs.find(item => item.id === tab.id)).toEqual(tab);
    expect(getDocumentDiscardPrompt()).toBeNull();
    panels.getState().closeTab(scope, tab.id);
    expect(getDocumentDiscardPrompt()?.names).toEqual(["Document.docx"]);
    resolveDocumentDiscardPrompt(false);
    expect(panels.getState().sessions[scope].tabs.some(item => item.id === tab.id)).toBe(true);
    finish(); await saving;
    expect(saves).toBe(1);
    expect(reconcileDocxSnapshot(loaded, published, false).data).toBe(draft);
    panels.getState().closeTab(scope, tab.id);
    expect(panels.getState().sessions[scope].tabs.some(item => item.id === tab.id)).toBe(false);
    panels.getState().openTab(scope, tab);
    expect(reconcileDocxSnapshot(null, published, false).data).toBe(draft);
  } finally { finish(); autosave.setEnabled(false); release(); if (getDocumentDiscardPrompt()) resolveDocumentDiscardPrompt(false); }
});
