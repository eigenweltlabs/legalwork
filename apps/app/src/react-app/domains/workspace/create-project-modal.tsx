import { RemoteFolderPicker, useRemoteFolderSources, type SelectedRemoteFolder } from "./remote-folder-picker";
import { applyProjectTemplate, localizedTemplateFields, useProjectDefaultsStore } from "./project-defaults-store";
import { useProjectTemplateCatalog } from "./project-template-catalog";
import { ProjectTemplateSelect } from "./project-template-select";
import { projectFieldsSchema, type ProjectField, type ProjectRecordReference, type RemoteFolderSelection } from "@legalwork/types/workspace";
import { ProjectCreationRecordPicker } from "./project-creation-record-picker";
import { projectReferenceObjects, useProjectBackOffice } from "./project-record-field";
import { ProjectMoreFields } from "./project-more-fields";
import { ProjectFieldDialog } from "./project-field-dialog";
import { ProjectProperties } from "./project-properties";
import { ProjectMetadata } from "./project-metadata";
import { primaryProjectObjects, withProjectField, projectConnectionField } from "./project-connections";
import { backOfficeObjectLabel } from "../back-office/labels";
import { projectErrorMessage } from "./project-errors";
import { useCallback, useEffect, useState } from "react";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { folderNameFromPath } from "@/react-app/shell/route-workspaces";
import { Cloud, Folder, FolderPlus, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { currentLocale, t } from "@/i18n";

export type CreateProjectInput = {
  name: string;
  templateId?: string | null;
  projectFields?: ProjectField[];
  templateLanguage: "en" | "de";
  matters?: ProjectRecordReference;
  remoteFolders?: RemoteFolderSelection[];
  initializeFromFolders?: boolean;
  folderMode: "default" | "selected";
  folderPath?: string;
};

export function CreateProjectModal(props: {
  open: boolean;
  client: LegalworkServerClient | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onConfirm: (input: CreateProjectInput) => Promise<void>;
}) {
  const catalog = useProjectTemplateCatalog(props.client, props.open);
  const directory = useProjectBackOffice(props.open ? props.client : null);
  const defaultTemplateId = useProjectDefaultsStore((state) => state.defaultTemplateId);
  const [selection, setTemplateId] = useState<string | null | undefined>();
  const templateId = selection === undefined ? defaultTemplateId : selection;
  const templates = useProjectDefaultsStore((state) => state.templates);
  const selectedTemplate = templates.find((template) => template.id === templateId);
  const sources = useRemoteFolderSources(props.client, props.open);
  const [remoteFolders, setRemoteFolders] = useState<SelectedRemoteFolder[]>([]);
  const [initializeFromFolders, setInitializeFromFolders] = useState(false);
  const [remotePicker, setRemotePicker] = useState(false);
  const [name, setName] = useState("");
  const [editedFields, setEditedFields] = useState<ProjectField[] | null>(null);
  const [extra, setExtra] = useState<ProjectField | null | undefined>();
  const [customizing, setCustomizing] = useState(false);
  const [creatingRecord, setCreatingRecord] = useState<string | null>(null);
  const onCreatingChange = useCallback((objectId: string, creating: boolean) => {
    setCreatingRecord(current => creating ? objectId : current === objectId ? null : current);
  }, []);
  const templateFields = localizedTemplateFields(selectedTemplate?.fields ?? []);
  const fields = editedFields ?? templateFields;
  const objects = projectReferenceObjects(directory.data);
  const connectionFields = primaryProjectObjects.map(objectId => projectConnectionField(fields, objectId, objects.find(object => object.id === objectId)?.plural ?? backOfficeObjectLabel(objectId)));
  const setField = (field: ProjectField) => setEditedFields(current => withProjectField(current ?? fields, field));
  const changeTemplate = (id: string | null) => {
    const template = templates.find(item => item.id === id) ?? { id: "none", name: "", fields: [] };
    const next = applyProjectTemplate(fields, template);
    if (next.length > 50) { setPickError(t("projects.templates.too_many_fields")); return; }
    setTemplateId(id);
    if (editedFields !== null) setEditedFields(next);
  };
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [folder, setFolder] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  useEffect(() => {
    if (props.open) {
      setName("");
      setEditedFields(null);
      setExtra(undefined);
      setCustomizing(false);
      setCreatingRecord(null);
      setTemplateId(undefined);
      setRemoteFolders([]); setInitializeFromFolders(false); setRemotePicker(false);
      setShowFolderInput(false);
      setFolder("");
      setPickError(null);
    }
  }, [props.open]);
  const hasFolders = Boolean(folder.trim() || remoteFolders.length);
  const setup = initializeFromFolders && hasFolders;
  useEffect(() => {
    if (!hasFolders) setInitializeFromFolders(false);
  }, [hasFolders]);
  const pick = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const path = await props.onPickFolder();
      if (path) setFolder(path);
    } catch (error) {
      setPickError(
        projectErrorMessage(error),
      );
    } finally {
      setPicking(false);
    }
  };
  return (
    <>
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.submitting) props.onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-3rem)] gap-6 overflow-y-auto rounded-3xl p-7 sm:max-w-xl sm:p-8"
        showCloseButton={!props.submitting}
      >
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-tight">{t("projects.create")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("projects.create_description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            if (!catalog.ready || props.submitting || creatingRecord) return;
            void props.onConfirm({
              name: (name.trim() || (folder.trim() ? folderNameFromPath(folder.trim()) : remoteFolders[0]?.name) || "Project").slice(0, 120),
              ...(editedFields !== null ? { projectFields: editedFields } : { templateId }),
              templateLanguage: currentLocale(),
              initializeFromFolders: setup,
              remoteFolders: remoteFolders.map(({ sourceWorkspaceId, connectionId, path }) => ({ sourceWorkspaceId, connectionId, path })),
              folderMode: folder.trim() ? "selected" : "default",
              ...(folder.trim() ? { folderPath: folder.trim() } : {}),
            });
          }}
        >
          <InputGroup className="h-12 rounded-xl bg-background">
            <InputGroupAddon className="h-full border-r border-border px-4 text-foreground"><Folder className="size-5" /></InputGroupAddon>
            <InputGroupInput autoFocus required={!setup} maxLength={120} aria-label={t("projects.name")} placeholder={t(setup ? "projects.setup.name_placeholder" : "projects.name")} value={name} disabled={props.submitting} className="h-full px-4 text-base" onChange={(event) => setName(event.target.value)} />
          </InputGroup>
          {props.open && <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("projects.connections.optional")}</p>
            <div className="flex flex-wrap items-start gap-2">
              {connectionFields.map(field => <ProjectCreationRecordPicker key={`${templateId}:${field.objectId}`} client={props.client} state={directory.data}
                field={field}
                disabled={props.submitting || !catalog.ready || (fields.length >= 50 && !fields.some(item => item.id === field.id))} onCreatingChange={onCreatingChange}
                onChange={value => {
                  if (!value && field.labelSource === "suggested" && !templateFields.some(item => item.id === field.id)) setEditedFields(current => (current ?? fields).filter(item => item.id !== field.id));
                  else setField({ ...field, value });
                }} />)}
              <ProjectMoreFields fields={fields} objects={objects} disabled={props.submitting || !catalog.ready} onChoose={setExtra} onNew={() => setExtra(null)} />
              <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={props.submitting || !catalog.ready} onClick={() => setCustomizing(true)}><Settings2 className="size-3.5" />{t("projects.customize_connections")}</Button>
            </div>
            <ProjectProperties client={props.client} fields={fields.filter(field => !connectionFields.some(primary => primary.id === field.id))} onSave={async (id, value) => {
              setEditedFields(current => projectFieldsSchema.parse((current ?? fields).map(field => field.id === id ? { ...field, value } : field)));
            }} />
            {directory.error && <p role="alert" className="text-xs text-destructive">{t("projects.connections.unavailable")}</p>}
          </div>}
          <ProjectTemplateSelect compact value={templateId} onChange={changeTemplate} disabled={props.submitting || !catalog.ready} />
          <fieldset disabled={props.submitting || picking} className="space-y-3">
            <legend className="mb-3 text-sm font-medium">{t("projects.source_folders")}</legend>
            <div className="flex min-h-36 flex-col justify-center gap-4 rounded-xl border border-border p-5">
              {folder && isDesktopRuntime() && <div className="flex items-center gap-3">
                <FolderIcon className="size-5 shrink-0" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm" title={folder}>{folderNameFromPath(folder)}</p><p className="text-xs text-muted-foreground">{t("projects.setup.local_folder")}</p></div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("projects.remove_source")} onClick={() => setFolder("")}><X /></Button>
              </div>}
              {showFolderInput && !isDesktopRuntime() && <div className="flex items-center gap-2">
                <Input aria-label={t("projects.location")} placeholder={t("projects.location")} value={folder} onChange={(event) => setFolder(event.target.value)} />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("projects.remove_source")} onClick={() => { setFolder(""); setShowFolderInput(false); }}><X /></Button>
              </div>}
              {remoteFolders.map((item, index) => <div className="flex items-center gap-3" key={`${item.sourceWorkspaceId}:${item.connectionId}:${item.path}`}>
                <FolderIcon className="size-5 shrink-0" />
                <div className="min-w-0 flex-1" title={`${item.connectionName}/${item.path}`}><p className="truncate text-sm">{item.name}</p><p className="truncate text-xs text-muted-foreground">{item.connectionName}{item.path ? ` / ${item.path}` : ""}</p></div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("projects.remote.unlink")} onClick={() => setRemoteFolders((items) => items.filter((_, i) => i !== index))}><X /></Button>
              </div>)}
              {!hasFolders && !showFolderInput && <p className="text-center text-sm text-muted-foreground">{t("projects.setup.add_folders")}</p>}
              <div className="flex flex-wrap justify-center gap-2">
                {!folder && !showFolderInput && <Button type="button" variant="secondary" size="sm" className="rounded-full" onClick={() => { if (isDesktopRuntime()) void pick(); else setShowFolderInput(true); }}><FolderPlus />{t("projects.setup.local_folder")}</Button>}
                {Boolean(sources.data?.sources.length) && <Button type="button" variant="secondary" size="sm" className="rounded-full" disabled={remoteFolders.length >= 30} onClick={() => setRemotePicker(true)}><Cloud />{t("projects.setup.remote_folder")}</Button>}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t(hasFolders ? "projects.setup.source_hint" : "projects.source_default_hint")}</p>
          </fieldset>
          <div className="flex items-start justify-between gap-5 border-t border-border/60 pt-5">
            <div className="space-y-1.5"><label htmlFor="project-folder-setup" className="cursor-pointer text-sm font-medium">{t("projects.setup.label")}</label><p id="project-folder-setup-hint" className="text-xs leading-relaxed text-muted-foreground">{t(hasFolders ? "projects.setup.hint" : "projects.setup.choose_first")}</p></div>
            <Switch id="project-folder-setup" className="mt-0.5" checked={setup} onCheckedChange={setInitializeFromFolders} disabled={!hasFolders || props.submitting || picking} aria-describedby="project-folder-setup-hint" />
          </div>
          {catalog.isError ? <p role="alert" className="text-sm text-destructive">{t("projects.templates.load_failed")} <Button type="button" variant="link" onClick={() => void catalog.refetch()}>{t("projects.templates.reload")}</Button></p> : null}
          {props.error || pickError ? (
            <p role="alert" className="text-sm text-destructive">
              {props.error || pickError || t("projects.failed")}
            </p>
          ) : null}
          <DialogFooter className="mx-0 mb-0 mt-7 gap-3 border-0 bg-transparent p-0">
            <Button
              type="button"
              variant="ghost"
              disabled={props.submitting}
              onClick={props.onClose}
            >
              {t("projects.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                props.submitting || picking || Boolean(creatingRecord) || !catalog.ready ||
                (!setup && !name.trim()) ||
                !props.client
              }
            >
              {props.submitting ? t("projects.creating") : t(setup ? "projects.setup.create" : "projects.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    {props.open && extra !== undefined && <ProjectFieldDialog key={extra?.id ?? "new"} client={props.client} field={extra ?? undefined} onClose={() => setExtra(undefined)} onSave={async field => { setField(field); }} />}
    {props.open && customizing && <Dialog open onOpenChange={setCustomizing}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t("projects.customize_connections")}</DialogTitle><DialogDescription>{t("projects.customize_connections_hint")}</DialogDescription></DialogHeader>
        <ProjectMetadata client={props.client} details={{ fields }} showTemplates={false} onCancel={() => setCustomizing(false)} onSave={async next => { setEditedFields(next); setCustomizing(false); }} />
      </DialogContent>
    </Dialog>}
    {remotePicker && props.client && <RemoteFolderPicker client={props.client} sources={sources.data?.sources ?? []} onClose={() => setRemotePicker(false)} onSelect={(item) => { setRemoteFolders((items) => items.some((value) => value.sourceWorkspaceId === item.sourceWorkspaceId && value.connectionId === item.connectionId && value.path === item.path) ? items : [...items, item]); setRemotePicker(false); }} />}
    </>
  );
}
