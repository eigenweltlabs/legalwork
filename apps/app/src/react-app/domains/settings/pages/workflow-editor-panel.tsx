import { lazy, Suspense, useCallback, useState } from "react";
import { FileText, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ArtifactFrame } from "../../session/artifacts/artifact-frame";
import { confirmDiscardDocuments } from "../../session/artifacts/docx-document-state";
import { SkillResourcesPanel, StagedResourcesField } from "./skill-resources-panel";
import { changeWorkflowTitle, discardWorkflow, editWorkflow, openWorkflow, refreshWorkflowResources, saveWorkflow, useWorkflowEditorStore, workflowDirty, workflowValidation } from "../state/workflow-editor-store";
import { workflowTitle } from "../state/workflow-document";
import { openWorkflowResource } from "../state/workflow-resource-store";

const MarkdownEditor = lazy(() => import("../../session/artifacts/artifact-markdown-editor").then((module) => ({ default: module.ArtifactMarkdownEditor })));
type EditorTab = "instructions" | "files" | "details";
const tabs: EditorTab[] = ["instructions", "files", "details"];

export function WorkflowEditorPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const draft = useWorkflowEditorStore((state) => state.drafts[id]);
  const services = useWorkflowEditorStore((state) => draft ? state.services[draft.workspaceId] : undefined);
  const [tab, setTab] = useState<EditorTab>(draft?.isNew ? "details" : "instructions");
  const imageUpload = useCallback((file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(t("workflows.image_failed")));
    reader.onerror = () => reject(new Error(t("workflows.image_failed")));
    reader.readAsDataURL(file);
  }), []);
  const imagePreview = useCallback(async (source: string) => source, []);
  if (!draft) return <div className="p-6 text-sm text-muted-foreground">{t("workflows.select_workflow")}</div>;

  const available = services && services.contextKey === draft.contextKey && services.currentContextKey() === draft.contextKey;
  const readOnly = !available || !services.canEdit || services.busy || draft.saving;
  const validation = workflowValidation(draft, new Set(services?.extensions.skills().map((skill) => skill.name)));
  const dirty = workflowDirty(draft);
  const fieldClass = "mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60";

  const reload = async () => {
    if (!services || !confirmDiscardDocuments(id)) return;
    // A clean draft has no discard callback invoked; remove it before re-reading.
    discardWorkflow(id);
    void openWorkflow(draft.workspaceId, { name: draft.name, path: "", description: draft.savedDescription });
  };

  return <div className="h-full min-h-0" onKeyDownCapture={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); event.stopPropagation();
      if (!readOnly && dirty) void saveWorkflow(id);
    }
  }}>
    <ArtifactFrame expandable title={draft.title || t("skills.new_workflow")} icon={<FileText className="size-4 text-muted-foreground" />}
      meta={<span role="status">{draft.saving ? t("common.saving") : dirty ? t("common.unsaved_changes") : t("common.saved")}</span>}
      actions={<>
        <Button size="sm" disabled={readOnly || draft.loading || !dirty || Boolean(validation)} onClick={() => void saveWorkflow(id)}>
          {draft.saving ? <Loader2 className="animate-spin" /> : null}{draft.isNew ? t("workflows.create") : t("common.save")}
        </Button>
        {!draft.isNew && draft.error ? <Button variant="ghost" size="icon-sm" aria-label={t("workflows.reload")} disabled={readOnly} onClick={() => void reload()}><RefreshCw /></Button> : null}
        <Button variant="ghost" size="icon-sm" aria-label={t("artifact.close")} disabled={draft.saving} onClick={onClose}><X /></Button>
      </>}
    >
      <div role="tablist" aria-label={t("workflows.editor_tabs")} className="flex shrink-0 gap-5 border-b border-border px-4">
        {tabs.map((value) => <button key={value} type="button" role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value}`} aria-selected={tab === value} onClick={() => setTab(value)}
          className={`border-b-2 py-3 text-xs transition-colors ${tab === value ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          {value === "instructions" ? t("workflows.instructions") : value === "files" ? t("workflows.files") : t("workflows.details")}{value === "files" && draft.staged.length ? ` · ${draft.staged.length}` : ""}
        </button>)}
      </div>
      {!available ? <p role="status" className="border-b border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">{t("workflows.reopen_workspace")}</p> : null}
      {draft.error ? <div role="alert" className="border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">{draft.error}</div> : null}
      {draft.loading ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("skills.loading")}</div> : <>
        <div role="tabpanel" id={`${id}-instructions`} aria-labelledby={`${id}-instructions-tab`} hidden={tab !== "instructions"} className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">{t("skills.loading")}</div>}>
            <MarkdownEditor value={draft.body} baseline={draft.savedBody} readOnly={readOnly} onChange={(body) => editWorkflow(id, { body, title: workflowTitle(body, draft.title) })} imageUpload={imageUpload} imagePreview={imagePreview} />
          </Suspense>
        </div>
        <div role="tabpanel" id={`${id}-files`} aria-labelledby={`${id}-files-tab`} hidden={tab !== "files"} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {draft.isNew || draft.staged.length ? <StagedResourcesField staged={draft.staged} disabled={readOnly} onChange={(staged) => editWorkflow(id, { staged })} /> : null}
          {draft.isNew ? <p className="mt-3 text-xs text-muted-foreground">{t("workflows.staged_files")}</p> : available && tab === "files" ? <SkillResourcesPanel embedded key={draft.name} skillName={draft.name} busy={readOnly} extensions={services.extensions} onChanged={() => void refreshWorkflowResources(id)} onEditResource={(resource) => void openWorkflowResource(id, resource)} /> : null}
        </div>
        <div role="tabpanel" id={`${id}-details`} aria-labelledby={`${id}-details-tab`} hidden={tab !== "details"} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
          <div><h3 className="text-sm font-semibold">{t("workflows.details")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("workflows.details_hint")}</p></div>
          <label className="block text-xs font-medium">{t("workflows.name")}<input autoFocus={draft.isNew} value={draft.title} disabled={readOnly} placeholder={t("skills.name_placeholder")} onChange={(event) => changeWorkflowTitle(draft, event.currentTarget.value)} className={fieldClass} /></label>
          <label className="block text-xs font-medium">{t("skills.description_when_to_use")}<textarea rows={3} value={draft.description} disabled={readOnly} placeholder={t("skills.description_placeholder_workflow")} onChange={(event) => editWorkflow(id, { description: event.currentTarget.value })} className={`${fieldClass} resize-y`} /></label>
          <div className="space-y-1 text-xs"><div className="font-medium">{t("workflows.type")}</div><div className="text-muted-foreground">{draft.type === "tabular" ? t("skills.tabular_workflow") : t("skills.assistant_workflow")}</div></div>
          {validation ? <p className="text-xs text-muted-foreground">{validation}</p> : null}
          {draft.isNew ? <Button variant="outline" size="sm" onClick={() => setTab("instructions")}>{t("workflows.write_instructions")}</Button> : null}
        </div>
      </>}
    </ArtifactFrame>
  </div>;
}
