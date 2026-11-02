import { useEffect } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ShutdownDialog } from "../../src/react-app/domains/session/artifacts/document-discard-dialog";
import { getUnsavedDocuments, registerDocumentShutdown, registerUnsavedDocument } from "../../src/react-app/domains/session/artifacts/docx-document-state";
import { bindWorkflowServices, createWorkflow, discardWorkflow, editWorkflow, useWorkflowEditorStore, type WorkflowServices } from "../../src/react-app/domains/settings/state/workflow-editor-store";
import { setLanguagePreference } from "../../src/i18n";

const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const page = document.createElement("main");
page.className = "mx-auto max-w-3xl space-y-4 p-10 text-foreground";
page.innerHTML = '<h1 class="text-2xl font-semibold">LegalWork</h1><p class="text-muted-foreground">Updates</p><button id="workflow-front" hidden>Workflow instructions</button>';
document.body.append(page);
let route = "/settings/updates";
let disk = "", writes = 0, opened = 0, markdown = "saved", markdownBaseline = "saved";
let cleanups: Array<() => void> = [];
window.addEventListener("legalwork:panel-open-tab", () => { opened++; const front = page.querySelector("button"); if (front) front.hidden = false; });
window.addEventListener("beforeunload", event => { if (markdown !== markdownBaseline) { event.preventDefault(); event.returnValue = ""; } });
function DialogFixture() {
  const location = useLocation();
  useEffect(() => {
    route = location.pathname;
    if (route.endsWith("/workflows")) {
      opened++;
      const front = page.querySelector("button");
      if (front) front.hidden = false;
    }
  }, [location.pathname]);
  return <ShutdownDialog />;
}
const fixture = {
  async setup({ baseline = false, visible = false, failure = false, extraMarkdown = false, clean = false, language = "en" }: { baseline?: boolean; visible?: boolean; failure?: boolean; extraMarkdown?: boolean; clean?: boolean; language?: "en" | "de" }) {
    cleanups.forEach(cleanup => cleanup()); cleanups = [];
    for (const id of Object.keys(useWorkflowEditorStore.getState().drafts)) discardWorkflow(id);
    disk = ""; writes = 0; opened = 0; markdown = "saved"; markdownBaseline = "saved";
    setLanguagePreference(language);
    const extensions: WorkflowServices["extensions"] = {
      skills: () => [], readSkill: async () => ({ content: disk }),
      saveSkill: async input => { if (failure) throw new Error("Synthetic write failure"); writes++; disk = input.content; },
      createSkill: async input => { disk = input.content; return { ok: true, message: "" }; },
      skillResources: () => [], skillResourcesStatus: () => null, refreshSkillResources: async () => {},
      readSkillResource: async () => null, saveSkillResource: async () => ({ ok: true, message: "" }), deleteSkillResource: async () => ({ ok: true, message: "" }),
    };
    cleanups.push(bindWorkflowServices("test", { extensions, contextKey: "test", currentContextKey: () => "test", canEdit: true, busy: false, resources: [], resourceStatus: null }));
    const draft = await createWorkflow("test", "assistant", { title: "Arbeitsvertragsprüfung (Standard-Check)", description: "Synthetic regression workflow" });
    if (!clean) editWorkflow(draft.id, { body: `${draft.body}\nUnsaved test edits.\n` });
    const front = page.querySelector("button");
    if (front) { front.id = `${draft.id}-instructions-tab`; front.hidden = !visible; }
    if (extraMarkdown) {
      markdown = "unsaved markdown";
      cleanups.push(registerUnsavedDocument("markdown", "Notes.md", () => markdown !== markdownBaseline));
      cleanups.push(registerDocumentShutdown("markdown", { save: async () => { markdownBaseline = markdown; return true; }, discard: () => { markdown = markdownBaseline; } }));
    }
    flushSync(() => root.render(baseline ? null : <MemoryRouter initialEntries={["/settings/updates"]}><DialogFixture /></MemoryRouter>));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  },
  state: () => ({ route, disk, writes, opened, dirty: getUnsavedDocuments().map(item => item.name), markdown, markdownBaseline }),
};
Object.assign(window, { shutdownFixture: fixture });
