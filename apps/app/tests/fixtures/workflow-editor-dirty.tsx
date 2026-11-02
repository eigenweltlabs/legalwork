import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { realmPlugin, rootEditor$, type ViewMode } from "@mdxeditor/editor";
import { $getRoot, $isTextNode, FORMAT_TEXT_COMMAND } from "lexical";
import { ArtifactMarkdownEditor } from "../../src/react-app/domains/session/artifacts/artifact-markdown-editor";
import { ShutdownDialog } from "../../src/react-app/domains/session/artifacts/document-discard-dialog";
import { bindWorkflowServices, discardWorkflow, editWorkflow, openWorkflow, useWorkflowEditorStore, workflowDirty, type WorkflowServices } from "../../src/react-app/domains/settings/state/workflow-editor-store";
import { newWorkflowContent } from "../../src/react-app/domains/settings/state/workflow-document";
import { getUnsavedDocuments } from "../../src/react-app/domains/session/artifacts/docx-document-state";
import { setLanguagePreference } from "../../src/i18n";

const host = document.createElement("div"); host.className = "h-screen"; document.body.append(host);
const root = createRoot(host);
const defaultBody = "# Review workflow\n\n## Steps\n1. Read the agreement.\n2. Check the clauses.\n\n## Checks\n- [ ] **Parties**: Confirm the parties.\n- [ ] **Term**: Review the term.\n\n| Clause | Finding |\n| --- | --- |\n| Term | Review |\n";
let id = "", revision = 0, changes = 0, strict = false, readOnly = false;
let request: { mode: ViewMode } | undefined;
let cleanup = () => {};
let format = () => {};
const commands = realmPlugin({ init(realm) {
  format = () => {
    const editor = realm.getValue(rootEditor$);
    editor?.update(() => {
      const text = $getRoot().getFirstDescendant();
      if ($isTextNode(text)) text.select(0, Math.min(3, text.getTextContentSize()));
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
    }, { discrete: true });
  };
} });
const extensions = [commands()];
const imageUpload = async () => "";
const imagePreview = async (source: string) => source;
function Editor() {
  const draft = useWorkflowEditorStore(state => state.drafts[id]);
  return <MemoryRouter><ShutdownDialog /><ArtifactMarkdownEditor value={draft.body} baseline={draft.savedBody} readOnly={readOnly} suppressHtmlProcessing extensions={extensions} viewModeRequest={request}
    onChange={body => { changes++; editWorkflow(id, { body }); }} imageUpload={imageUpload} imagePreview={imagePreview} /></MemoryRouter>;
}
function render() { flushSync(() => root.render(strict ? <StrictMode><Editor key={revision} /></StrictMode> : <Editor key={revision} />)); }
Object.assign(window, { workflowEditorFixture: {
  async load(options: { body?: string; strict?: boolean; readOnly?: boolean } = {}) {
    flushSync(() => root.render(null)); cleanup();
    for (const key of Object.keys(useWorkflowEditorStore.getState().drafts)) discardWorkflow(key);
    const body = options.body ?? defaultBody;
    const content = newWorkflowContent("workflow-assistant-test", "Synthetic review instructions", body);
    const extensions: WorkflowServices["extensions"] = {
      skills: () => [], readSkill: async () => ({ content }), saveSkill: async () => {}, createSkill: async () => ({ ok: true, message: "" }),
      skillResources: () => [], skillResourcesStatus: () => null, refreshSkillResources: async () => {}, readSkillResource: async () => null,
      saveSkillResource: async () => ({ ok: true, message: "" }), deleteSkillResource: async () => ({ ok: true, message: "" }),
    };
    cleanup = bindWorkflowServices("test", { extensions, contextKey: "test", currentContextKey: () => "test", canEdit: true, busy: false, resources: [], resourceStatus: null });
    setLanguagePreference("en");
    await openWorkflow("test", { name: "workflow-assistant-test", path: "SKILL.md", description: "Synthetic review instructions" });
    id = Object.keys(useWorkflowEditorStore.getState().drafts)[0];
    revision++; changes = 0; request = undefined; strict = options.strict ?? false; readOnly = options.readOnly ?? false;
    render();
  },
  snapshot() { const draft = useWorkflowEditorStore.getState().drafts[id]; return { dirty: workflowDirty(draft), changes, body: draft.body, savedBody: draft.savedBody, unsaved: getUnsavedDocuments().length }; },
  mode(mode: ViewMode) { request = { mode }; render(); },
  replace(body: string) { editWorkflow(id, { body, savedBody: body }); },
  format: () => format(),
} });
