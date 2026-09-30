import { create } from "zustand";
import type { SkillCard } from "@/app/types";
import { t } from "@/i18n";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { registerUnsavedDocument } from "../../session/artifacts/docx-document-state";
import { requestPanelTab } from "../../session/panel/panel-tab-request";
import { usePanelTabStore } from "../../session/panel/panel-tab-store";
import type { SkillsExtensionsStore } from "../pages/skills-view";
import { flushStagedResources, type StagedResourceFile } from "../pages/skill-resources-panel";
import { newWorkflowContent, readWorkflowDocument, renameWorkflowTitle, workflowDisplayName, workflowName, workflowTitle, workflowType, writeWorkflowDocument, type WorkflowType } from "./workflow-document";

export type WorkflowServices = {
  extensions: Pick<SkillsExtensionsStore, "skills" | "readSkill" | "saveSkill" | "createSkill" | "skillResources" | "skillResourcesStatus" | "refreshSkillResources" | "readSkillResource" | "saveSkillResource" | "deleteSkillResource">;
  contextKey: string;
  currentContextKey: () => string;
  canEdit: boolean;
  busy: boolean;
  resources: ReturnType<SkillsExtensionsStore["skillResources"]>;
  resourceStatus: string | null;
};

export type WorkflowDraft = {
  id: string;
  workspaceId: string;
  contextKey: string;
  name: string;
  title: string;
  description: string;
  savedDescription: string;
  type: WorkflowType;
  body: string;
  savedBody: string;
  baseline: string;
  isNew: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  staged: StagedResourceFile[];
};

export function workflowDirty(draft: WorkflowDraft) {
  return draft.isNew || draft.body !== draft.savedBody || draft.description !== draft.savedDescription || draft.staged.length > 0;
}

type EditorState = {
  drafts: Record<string, WorkflowDraft>;
  services: Record<string, WorkflowServices>;
};

export const useWorkflowEditorStore = create<EditorState>(() => ({ drafts: {}, services: {} }));
const registrations = new Map<string, () => void>();

// Drafts outlive the visible panel, so window-close protection must do so too.
if (typeof window !== "undefined") {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!Object.values(useWorkflowEditorStore.getState().drafts).some((draft) => draft.saving || workflowDirty(draft))) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  import.meta.hot?.dispose(() => window.removeEventListener("beforeunload", beforeUnload));
}

export function bindWorkflowServices(workspaceId: string, services: WorkflowServices) {
  useWorkflowEditorStore.setState((state) => ({ services: { ...state.services, [workspaceId]: services } }));
  return () => {
    if (useWorkflowEditorStore.getState().services[workspaceId] !== services) return;
    useWorkflowEditorStore.setState((state) => {
      const next = { ...state.services };
      delete next[workspaceId];
      return { services: next };
    });
  };
}

export function workflowDraftId(workspaceId: string, name: string) {
  return `workflow:${JSON.stringify([workspaceId, name])}`;
}

export function editWorkflow(id: string, patch: Partial<WorkflowDraft>) {
  useWorkflowEditorStore.setState((state) => {
    const current = state.drafts[id];
    return current ? { drafts: { ...state.drafts, [id]: { ...current, ...patch } } } : state;
  });
}

export function discardWorkflow(id: string) {
  registrations.get(id)?.();
  registrations.delete(id);
  useWorkflowEditorStore.setState((state) => {
    const drafts = { ...state.drafts };
    delete drafts[id];
    return { drafts };
  });
}

function addDraft(draft: WorkflowDraft) {
  useWorkflowEditorStore.setState((state) => ({ drafts: { ...state.drafts, [draft.id]: draft } }));
  registrations.get(draft.id)?.();
  registrations.set(draft.id, registerUnsavedDocument(draft.id, draft.title || t("skills.new_workflow"), () => {
    const current = useWorkflowEditorStore.getState().drafts[draft.id];
    return Boolean(current && (current.saving || workflowDirty(current)));
  }, () => discardWorkflow(draft.id), true));
}

function servicesFor(draft: WorkflowDraft) {
  const services = useWorkflowEditorStore.getState().services[draft.workspaceId];
  if (!services || services.contextKey !== draft.contextKey || services.currentContextKey() !== draft.contextKey) throw new Error(t("workflows.reopen_workspace"));
  return services;
}

export function showWorkflow(draft: WorkflowDraft) {
  requestPanelTab({ id: draft.id, type: "workflow", label: draft.title || t("skills.new_workflow") });
}

export async function openWorkflow(workspaceId: string, skill: SkillCard) {
  const services = useWorkflowEditorStore.getState().services[workspaceId];
  if (!services) return;
  const existing = Object.values(useWorkflowEditorStore.getState().drafts).find((draft) => draft.workspaceId === workspaceId && draft.name === skill.name && !draft.isNew);
  if (existing && (existing.loading || existing.saving || workflowDirty(existing))) { showWorkflow(existing); return; }
  const draft: WorkflowDraft = {
    id: existing?.id ?? workflowDraftId(workspaceId, skill.name), workspaceId, contextKey: services.contextKey, name: skill.name,
    title: workflowDisplayName(skill.name), description: skill.description ?? "", savedDescription: skill.description ?? "",
    type: workflowType(skill), body: "", savedBody: "", baseline: "", isNew: false, loading: true, saving: false, error: null, staged: [],
  };
  addDraft(draft);
  showWorkflow(draft);
  try {
    const result = await servicesFor(draft).extensions.readSkill(skill.name);
    if (!result) throw new Error(t("skills.skill_load_failed"));
    const body = readWorkflowDocument(result.content).body;
    editWorkflow(draft.id, { baseline: result.content, body, savedBody: body, title: workflowTitle(body, draft.title), loading: false });
  } catch (error) { editWorkflow(draft.id, { loading: false, error: errorMessage(error) }); }
}

/** Create from the short setup dialog; only publish a saved document to the editor. */
export async function createWorkflow(workspaceId: string, type: WorkflowType, input: { title: string; description: string }) {
  const boundServices = useWorkflowEditorStore.getState().services[workspaceId];
  if (!boundServices) throw new Error(t("workflows.reopen_workspace"));
  const title = input.title.trim();
  const description = input.description.trim();
  const name = workflowName(title, type);
  const body = `# ${title}\n\n${t("workflows.assistant_starter")}\n`;
  const draft: WorkflowDraft = {
    id: workflowDraftId(workspaceId, name), workspaceId, contextKey: boundServices.contextKey, name, title, description, savedDescription: description,
    type, body, savedBody: body, baseline: "", isNew: true, loading: false, saving: false, error: null, staged: [],
  };
  const services = servicesFor(draft);
  if (!services.canEdit || services.busy) throw new Error(t("workflows.creation_unavailable"));
  const invalid = workflowValidation(draft, new Set(services.extensions.skills().map((skill) => skill.name)));
  if (invalid) throw new Error(invalid);
  const content = newWorkflowContent(name, description, body);
  const result = await services.extensions.createSkill({ name, content, description });
  if (!result.ok) throw new Error(result.message);
  const saved = { ...draft, isNew: false, baseline: content };
  addDraft(saved);
  captureAnalyticsEvent("workflow_created", {});
  return saved;
}

export function changeWorkflowTitle(draft: WorkflowDraft, title: string) {
  editWorkflow(draft.id, { title, body: renameWorkflowTitle(draft.body, title) });
}

export function workflowValidation(draft: WorkflowDraft, names: Set<string>) {
  if (!draft.title.trim() || !draft.description.trim() || !draft.body.trim()) return t("workflows.required_fields");
  const name = workflowName(draft.title, draft.type);
  if (draft.isNew && (!name || name.length > 64)) return t("skills.title_invalid");
  if (draft.isNew && names.has(name)) return t("workflows.name_taken");
  return null;
}

/** Attachment writes only advance the managed section, never the user's draft. */
export async function refreshWorkflowResources(id: string) {
  const draft = useWorkflowEditorStore.getState().drafts[id];
  if (!draft || draft.isNew) return;
  try {
    const result = await servicesFor(draft).extensions.readSkill(draft.name);
    if (!result) throw new Error(t("skills.skill_load_failed"));
    const before = readWorkflowDocument(draft.baseline);
    const after = readWorkflowDocument(result.content);
    if (before.body.trimEnd() !== after.body.trimEnd() || before.frontmatter !== after.frontmatter) throw new Error(t("workflows.disk_changed"));
    editWorkflow(id, { baseline: result.content });
  } catch (error) { editWorkflow(id, { error: errorMessage(error) }); }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("common.something_went_wrong");
}

export async function saveWorkflow(id: string) {
  const draft = useWorkflowEditorStore.getState().drafts[id];
  if (!draft || draft.loading || draft.saving) return false;
  try {
    const services = servicesFor(draft);
    if (!services.canEdit || services.busy) return false;
    const invalid = workflowValidation(draft, new Set(services.extensions.skills().map((skill) => skill.name)));
    if (invalid) throw new Error(invalid);
    editWorkflow(id, { saving: true, error: null });
    const name = draft.isNew ? workflowName(draft.title, draft.type) : draft.name;
    let content: string;
    if (draft.isNew) {
      content = newWorkflowContent(name, draft.description, draft.body);
      const result = await services.extensions.createSkill({ name, content, description: draft.description });
      if (!result.ok) throw new Error(result.message);
      captureAnalyticsEvent("workflow_created", {});
    } else {
      const latest = await services.extensions.readSkill(name);
      if (!latest) throw new Error(t("skills.skill_load_failed"));
      const before = readWorkflowDocument(draft.baseline);
      const after = readWorkflowDocument(latest.content);
      if (before.body.trimEnd() !== after.body.trimEnd() || before.frontmatter !== after.frontmatter) throw new Error(t("workflows.disk_changed"));
      servicesFor(draft);
      content = writeWorkflowDocument(latest.content, draft.body, draft.description === draft.savedDescription ? undefined : draft.description);
      // The document already contains the description; retain all other metadata.
      await services.extensions.saveSkill({ name, content });
    }
    // Keep edits made during the request dirty by advancing only the saved baseline.
    editWorkflow(id, { name, isNew: false, baseline: content, savedBody: draft.body, savedDescription: draft.description });
    if (draft.staged.length) {
      const failed = await flushStagedResources(services.extensions.saveSkillResource, name, draft.staged);
      const attempted = new Set(draft.staged.map((file) => file.name));
      const current = useWorkflowEditorStore.getState().drafts[id];
      if (current) editWorkflow(id, { staged: current.staged.filter((file) => !attempted.has(file.name) || failed.includes(file.name)) });
      await refreshWorkflowResources(id);
      if (failed.length) throw new Error(t("skill_resources.staged_upload_failed", { names: failed.join(", ") }));
    }
    // Labels follow edits without selecting or reopening a tab the user left.
    usePanelTabStore.setState((state) => ({ sessions: Object.fromEntries(Object.entries(state.sessions).map(([key, session]) => [key, {
      ...session, tabs: session.tabs.map((tab) => tab.id === id ? { ...tab, label: draft.title } : tab),
    }])) }));
    return true;
  } catch (error) {
    editWorkflow(id, { error: errorMessage(error) });
    return false;
  } finally { editWorkflow(id, { saving: false }); }
}
