import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import type { ProjectDetails } from "@legalwork/types/workspace";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { isWindowsPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { ProjectPersonalisationSection } from "../settings/pages/project-personalisation-section";
import { ProjectMetadata } from "./project-metadata";
import { defaultAkteFields, useProjectDefaultsStore, withInitialProjectFields } from "./project-defaults-store";
import { ProjectLinkedFoldersSection } from "./project-remote-folders";
import { ProjectSharingSection } from "./project-sync";
import { projectErrorMessage } from "./project-errors";

export type ProjectSettingsSection = "general" | "writing" | "fields" | "sharing" | "folders";
type Props = {
  workspace: WorkspaceInfo;
  client: LegalworkServerClient | null;
  workspaceId: string;
  initialSection: ProjectSettingsSection;
  onClose: () => void;
  onRename: (name: string) => Promise<boolean>;
  onReveal: () => void;
  onForget: () => void;
};
const sections: { id: ProjectSettingsSection; label: string }[] = [
  { id: "general", label: "project_settings.general" },
  { id: "writing", label: "project_settings.writing" },
  { id: "fields", label: "project_settings.fields" },
  { id: "sharing", label: "project_settings.sharing" },
  { id: "folders", label: "projects.remote.linked" },
];

export function ProjectSettingsPanel(props: Props) {
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<ProjectSettingsSection>(props.initialSection);
  const name = props.workspace.displayName || props.workspace.name;
  const queryClient = useQueryClient();
  const local = props.workspace.workspaceType === "local";
  const availableSections = sections.filter(item => local || item.id !== "sharing");
  const close = () => {
    if (busy) return;
    void queryClient.invalidateQueries({ queryKey: ["project", props.workspaceId] });
    props.onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent showCloseButton={!busy} className="max-h-[85vh] overflow-y-auto rounded-2xl sm:max-w-4xl" data-testid="project-settings-panel">
      <DialogHeader>
        <DialogTitle>{t("project_settings.title")}</DialogTitle>
        <DialogDescription>{name}</DialogDescription>
      </DialogHeader>
      <Tabs orientation="vertical" value={section} onValueChange={value => {
        const next = availableSections.find(item => item.id === value);
        if (next) setSection(next.id);
      }} className="flex-col gap-6 sm:flex-row">
        <TabsList variant="line" aria-label={t("project_settings.sections")} className="w-full flex-row! flex-wrap justify-start! p-0 sm:w-44 sm:shrink-0 sm:flex-col!">
          {availableSections.map(item => <TabsTrigger disabled={busy} key={item.id} value={item.id} className="h-auto flex-none justify-start rounded-lg px-3 py-2 text-left whitespace-normal sm:w-full data-active:bg-muted! after:hidden">{t(item.label)}</TabsTrigger>)}
        </TabsList>
        <div className="min-w-0 flex-1">
          <TabsContent value="general" keepMounted><ProjectGeneralSection {...props} name={name} /></TabsContent>
          <TabsContent value="writing" keepMounted><ProjectPersonalisationSection client={props.client} workspaceId={props.workspaceId} projectName={name} active={section === "writing"} /></TabsContent>
          <TabsContent value="fields" keepMounted>{props.client ? <ProjectFieldsSection client={props.client} workspaceId={props.workspaceId} active={section === "fields"} onClose={close} /> : <ConnectionNotice />}</TabsContent>
          {local ? <TabsContent value="sharing" keepMounted>{props.client ? <ProjectSharingSection client={props.client} workspaceId={props.workspaceId} projectName={name} onClose={props.onClose} onBusyChange={setBusy} /> : <ConnectionNotice />}</TabsContent> : null}
          <TabsContent value="folders" keepMounted>{props.client ? <ProjectLinkedFoldersSection client={props.client} workspaceId={props.workspaceId} /> : <ConnectionNotice />}</TabsContent>
        </div>
      </Tabs>
    </DialogContent>
  </Dialog>;
}

function ConnectionNotice() {
  return <p role="status" className="text-sm text-muted-foreground">{t("personalisation.server_required")}</p>;
}

function ProjectGeneralSection(props: Props & { name: string }) {
  const id = useId();
  const [draft, setDraft] = useState(props.name);
  const [busy, setBusy] = useState(false);
  return <form className="space-y-5" onSubmit={async event => {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    try { if (await props.onRename(draft)) toast.success(t("common.saved")); }
    finally { setBusy(false); }
  }}>
    <h3 className="font-medium">{t("project_settings.general")}</h3>
    <div className="space-y-2"><label htmlFor={id} className="text-sm font-medium">{t("projects.name")}</label><Input id={id} value={draft} disabled={busy} required maxLength={200} onChange={event => setDraft(event.target.value)} /></div>
    <div className="space-y-2"><p className="text-sm font-medium">{t("projects.location")}</p><p className="break-all text-sm text-muted-foreground">{props.workspace.path || props.workspace.directory || props.workspace.baseUrl}</p>
      {props.workspace.workspaceType === "local" ? <Button type="button" variant="outline" size="sm" onClick={props.onReveal}><FolderOpen />{t(isWindowsPlatform() ? "workspace_list.reveal_explorer" : "workspace_list.reveal_finder")}</Button> : null}
    </div>
    <div className="flex justify-end"><Button type="submit" disabled={busy || !draft.trim() || draft.trim() === props.name}>{t("common.save")}</Button></div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"><p className="text-xs text-muted-foreground">{t("project_settings.remove_hint")}</p><Button type="button" variant="ghost" className="text-destructive" disabled={busy} onClick={props.onForget}>{t("project_settings.remove")}</Button></div>
  </form>;
}

function ProjectFieldsSection(props: { client: LegalworkServerClient; workspaceId: string; active: boolean; onClose: () => void }) {
  const details = useQuery({ queryKey: ["project", props.workspaceId], queryFn: () => props.client.getProjectDetails(props.workspaceId), enabled: props.active });
  if (!details.data) return <div className="space-y-3">
    <p role={details.error ? "alert" : "status"} className={details.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{details.error ? projectErrorMessage(details.error) : t("projects.loading")}</p>
    {details.error ? <Button variant="outline" onClick={() => void details.refetch()}>{t("workspace_files.try_again")}</Button> : null}
  </div>;
  return <ProjectFieldsEditor {...props} details={details.data} />;
}

function ProjectFieldsEditor(props: { client: LegalworkServerClient; workspaceId: string; onClose: () => void; details: ProjectDetails }) {
  const defaults = useProjectDefaultsStore(state => state.fields);
  const [base, setBase] = useState(props.details);
  const queryClient = useQueryClient();
  useEffect(() => {
    // A writing prompt save changes the shared revision without changing fields.
    // Keep field drafts intact while advancing that revision for the next save.
    if (props.details.revision !== base.revision && JSON.stringify(props.details.fields) === JSON.stringify(base.fields)) setBase(props.details);
  }, [props.details, base]);
  return <div><h3 className="font-medium">{t("project_settings.fields")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("projects.metadata_hint")}</p>
    <ProjectMetadata details={withInitialProjectFields(base, defaults ?? defaultAkteFields())} onCancel={props.onClose} onReload={async () => {
      const data = await props.client.getProjectDetails(props.workspaceId);
      setBase(data);
      queryClient.setQueryData(["project", props.workspaceId], data);
      return withInitialProjectFields(data, defaults ?? defaultAkteFields());
    }} onSave={async fields => {
      const data = await props.client.updateProjectDetails(props.workspaceId, { revision: base.revision, fields });
      setBase(data);
      queryClient.setQueryData(["project", props.workspaceId], data);
      toast.success(t("common.saved"));
    }} />
  </div>;
}
