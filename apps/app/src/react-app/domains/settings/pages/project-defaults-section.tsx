import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { useProjectTemplateCatalog } from "../../workspace/project-template-catalog";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LayoutSection, LayoutSectionHeader, LayoutSectionTitle, LayoutSectionDescription, LayoutSectionItem, LayoutSectionItemHeader, LayoutSectionItemTitle, LayoutSectionItemHeaderActions } from "../settings-layout";
import { ProjectMetadata } from "../../workspace/project-metadata";
import { projectFieldLabel, projectTemplateName, useProjectDefaultsStore, type ProjectMetadataTemplate } from "../../workspace/project-defaults-store";
import { ProjectTemplateSelect } from "../../workspace/project-template-select";
import { t } from "@/i18n";

export function ProjectDefaultsSection({ client = null }: { client?: LegalworkServerClient | null }) {
  const catalog = useProjectTemplateCatalog(client);
  const [error, setError] = useState(false);
  const disabled = !catalog.ready || catalog.saving;
  const templates = useProjectDefaultsStore((state) => state.templates);
  const defaultTemplateId = useProjectDefaultsStore((state) => state.defaultTemplateId);
  const save = async (edit: Parameters<typeof catalog.save>[0]) => {
    setError(false);
    try { await catalog.save(edit); }
    catch (error) { setError(true); throw error; }
  };
  const [editingRevision, setEditingRevision] = useState(0);
  const startEditing = (template: ProjectMetadataTemplate) => {
    if (!catalog.data) return;
    setEditingRevision(catalog.data.revision);
    setEditing(template);
  };
  const [editing, setEditing] = useState<ProjectMetadataTemplate | null>(null);
  return <LayoutSection>
    <LayoutSectionHeader>
      <LayoutSectionTitle>{t("projects.templates.title")}</LayoutSectionTitle>
      <LayoutSectionDescription>{t("projects.templates.hint")}</LayoutSectionDescription>
    </LayoutSectionHeader>
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("projects.templates.default")}</LayoutSectionItemTitle>
      </LayoutSectionItemHeader>
      <ProjectTemplateSelect value={defaultTemplateId} disabled={disabled} onChange={(id) => { void save((current) => ({ ...current, defaultTemplateId: id })).catch(() => undefined); }} />
    </LayoutSectionItem>
    {error || catalog.isError ? <p role="alert" className="text-sm text-destructive">{t(error ? "projects.templates.save_failed" : "projects.templates.load_failed")} <Button variant="link" onClick={() => { setError(false); void catalog.refetch(); }}>{t("projects.templates.reload")}</Button></p> : null}
    {templates.map((template) => <LayoutSectionItem key={template.id}>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{projectTemplateName(template)}</LayoutSectionItemTitle>
        <LayoutSectionItemHeaderActions>
          <Button disabled={disabled} size="sm" variant="outline" onClick={() => startEditing({ ...template, name: projectTemplateName(template) })}>{t("projects.edit")}</Button>
          <Button disabled={disabled} size="icon-sm" variant="ghost" aria-label={t("projects.templates.remove", { name: projectTemplateName(template) })} onClick={() => { void save((current) => ({ ...current, templates: current.templates.filter((entry) => entry.id !== template.id), defaultTemplateId: current.defaultTemplateId === template.id ? null : current.defaultTemplateId })).catch(() => undefined); }}><Trash2 className="size-4" /></Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
      <div className="flex flex-wrap gap-2">{template.fields.map((field) => <Badge key={field.id} variant="secondary" className="font-normal">{projectFieldLabel(field)}</Badge>)}</div>
    </LayoutSectionItem>)}
    <Button disabled={disabled} className="self-start" variant="outline" onClick={() => startEditing({ id: crypto.randomUUID(), name: "", nameSource: "custom", fields: [] })}><Plus className="size-4" />{t("projects.templates.add")}</Button>
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t("projects.templates.edit")}</DialogTitle><DialogDescription>{t("projects.templates.edit_hint")}</DialogDescription></DialogHeader>
        {editing ? <ProjectMetadata client={client} key={`${editing.id}:${editingRevision}`} isTemplate details={{ fields: editing.fields }} saveDisabled={disabled || !editing.name.trim()} onCancel={() => setEditing(null)} onReload={async () => {
          const latest = await catalog.refetch();
          if (!latest.data || latest.error) throw latest.error;
          const template = latest.data.templates.find((entry) => entry.id === editing.id);
          if (template) { setEditing({ ...template, name: projectTemplateName(template) }); setEditingRevision(latest.data.revision); }
          else setEditing(null);
          return { fields: template?.fields ?? [] };
        }} onSave={async (fields) => { await save((current) => ({ ...current, revision: editingRevision, templates: current.templates.some((entry) => entry.id === editing.id) ? current.templates.map((entry) => entry.id === editing.id ? { ...editing, fields } : entry) : [...current.templates, { ...editing, fields }] })); setEditing(null); }}>
          <label className="grid gap-2 text-sm font-medium">
            {t("projects.templates.name")}
            <Input autoFocus required maxLength={100} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value, nameSource: "custom" })} />
          </label>
        </ProjectMetadata> : null}
      </DialogContent>
    </Dialog>
  </LayoutSection>;
}
