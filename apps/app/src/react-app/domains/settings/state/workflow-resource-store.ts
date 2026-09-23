import { create } from "zustand";
import type { SkillResourceCard } from "@/app/types";
import { t } from "@/i18n";
import { registerUnsavedDocument } from "../../session/artifacts/docx-document-state";
import { requestPanelTab } from "../../session/panel/panel-tab-request";
import { refreshWorkflowResources, useWorkflowEditorStore } from "./workflow-editor-store";
import { isDocumentWorkflowResource, isEditableWorkflowResource, isTextWorkflowResource } from "./workflow-resource-type";

export type WorkflowResourceDraft = {
  id: string;
  workflowId: string;
  workspaceId: string;
  contextKey: string;
  skillName: string;
  name: string;
  path: string;
  content: string;
  baseline: string;
  documentDirty: boolean;
  revision: number;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
};

export const useWorkflowResourceStore = create<{ drafts: Record<string, WorkflowResourceDraft> }>(() => ({ drafts: {} }));
const registrations = new Map<string, () => void>();
export const resourceDirty = (draft: WorkflowResourceDraft) => draft.documentDirty || draft.content !== draft.baseline;

export function resourceBuffer(content: string): ArrayBuffer {
  return Uint8Array.from(atob(content), (character) => character.charCodeAt(0)).buffer;
}

export function resourceBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function editWorkflowResource(id: string, patch: Partial<WorkflowResourceDraft>) {
  useWorkflowResourceStore.setState((state) => {
    const draft = state.drafts[id];
    return draft ? { drafts: { ...state.drafts, [id]: { ...draft, ...patch } } } : state;
  });
}

export function discardWorkflowResource(id: string) {
  registrations.get(id)?.();
  registrations.delete(id);
  useWorkflowResourceStore.setState((state) => {
    const drafts = { ...state.drafts };
    delete drafts[id];
    return { drafts };
  });
}

function servicesFor(draft: WorkflowResourceDraft) {
  const services = useWorkflowEditorStore.getState().services[draft.workspaceId];
  if (!services || services.contextKey !== draft.contextKey || services.currentContextKey() !== draft.contextKey) {
    throw new Error(t("workflows.reopen_workspace"));
  }
  return services;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("skill_resources.save_failed");
}

async function readResource(draft: WorkflowResourceDraft) {
  const result = await servicesFor(draft).extensions.readSkillResource(draft.skillName, draft.name, "base64");
  if (!result) throw new Error(t("skill_resources.load_failed"));
  return { ...result, content: isTextWorkflowResource(draft.name)
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(resourceBuffer(result.content))
    : result.content };
}

/** Read and write through the skill resource API, never through workspace copies. */
export async function openWorkflowResource(workflowId: string, resource: SkillResourceCard) {
  const workflow = useWorkflowEditorStore.getState().drafts[workflowId];
  if (!workflow || workflow.isNew) return;
  const services = useWorkflowEditorStore.getState().services[workflow.workspaceId];
  if (!services || services.contextKey !== workflow.contextKey || services.currentContextKey() !== workflow.contextKey) return;
  const id = `workflow-resource:${JSON.stringify([workflow.workspaceId, services.contextKey, workflow.name, resource.name])}`;
  const existing = useWorkflowResourceStore.getState().drafts[id];
  if (existing && (existing.loading || existing.saving || resourceDirty(existing))) {
    requestPanelTab({ id, type: "workflow-resource", label: resource.name });
    return id;
  }
  const draft: WorkflowResourceDraft = {
    id, workflowId, workspaceId: workflow.workspaceId, contextKey: services.contextKey, skillName: workflow.name,
    name: resource.name, path: resource.path, content: "", baseline: "", documentDirty: false, revision: 0, loaded: false, loading: true, saving: false, error: null,
  };
  useWorkflowResourceStore.setState((state) => ({ drafts: { ...state.drafts, [id]: draft } }));
  registrations.get(id)?.();
  registrations.set(id, registerUnsavedDocument(id, resource.name, () => {
    const current = useWorkflowResourceStore.getState().drafts[id];
    return Boolean(current && (current.saving || resourceDirty(current)));
  }, () => {
    if (!isDocumentWorkflowResource(resource.name)) { discardWorkflowResource(id); return; }
    const current = useWorkflowResourceStore.getState().drafts[id];
    if (current) editWorkflowResource(id, { content: current.baseline, documentDirty: false, revision: current.revision + 1 });
  }, !isDocumentWorkflowResource(resource.name)));
  requestPanelTab({ id, type: "workflow-resource", label: resource.name });
  await reloadWorkflowResource(id);
  return id;
}

export async function reloadWorkflowResource(id: string) {
  const draft = useWorkflowResourceStore.getState().drafts[id];
  if (!draft || draft.saving) return;
  editWorkflowResource(id, { loading: true, error: null });
  try {
    const result = await readResource(draft);
    servicesFor(draft);
    editWorkflowResource(id, { path: result.path, content: result.content, baseline: result.content, documentDirty: false, revision: draft.revision + 1, loaded: true });
  } catch (error) { editWorkflowResource(id, { error: errorMessage(error) }); }
  finally { editWorkflowResource(id, { loading: false }); }
}

export async function saveWorkflowResource(id: string) {
  const draft = useWorkflowResourceStore.getState().drafts[id];
  if (!draft || !draft.loaded || draft.loading || draft.saving || !isEditableWorkflowResource(draft.name)) return false;
  try {
    const services = servicesFor(draft);
    if (!services.canEdit || services.busy) return false;
    if (!resourceDirty(draft)) return true;
    editWorkflowResource(id, { saving: true, error: null });
    const latest = await readResource(draft);
    if (!latest || latest.path !== draft.path || latest.content !== draft.baseline) throw new Error(t("workflows.file_changed"));
    const currentServices = servicesFor(draft);
    if (!currentServices.canEdit || currentServices.busy) throw new Error(t("skill_resources.unavailable"));
    const result = await currentServices.extensions.saveSkillResource(draft.skillName, {
      name: draft.name,
      ...(isTextWorkflowResource(draft.name) ? { content: draft.content } : { contentBase64: draft.content }),
    });
    if (!result.ok) throw new Error(result.message);
    // Advance only the submitted baseline, preserving edits made during a save.
    editWorkflowResource(id, { baseline: draft.content });
    await refreshWorkflowResources(draft.workflowId);
    return true;
  } catch (error) {
    editWorkflowResource(id, { error: errorMessage(error) });
    return false;
  } finally { editWorkflowResource(id, { saving: false }); }
}

if (typeof window !== "undefined") {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!Object.values(useWorkflowResourceStore.getState().drafts).some((draft) => draft.saving || resourceDirty(draft))) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  import.meta.hot?.dispose(() => window.removeEventListener("beforeunload", beforeUnload));
}
