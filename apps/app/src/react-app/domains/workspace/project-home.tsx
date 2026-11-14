import { projectFieldsSchema, type ProjectDetails, type ProjectField } from "@legalwork/types/workspace";
import { ProjectRemoteFolders } from "./project-remote-folders";
import { useProjectPersonalisation } from "./project-personalisation-modal";
import { useEffect, useState, type ReactNode } from "react";
import type { AudioRecordingMeta } from "@legalwork/types/audio";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, MessageSquare, Mic, Pin, Plus, RefreshCw, Settings2, Square, SquareCheck, SquarePen, Star, StickyNote, WandSparkles } from "lucide-react";
import { LegalworkServerError, type LegalworkServerClient, type LegalworkWorkspaceDirectoryEntry } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/sonner";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { ProjectProperties } from "./project-properties";
import { ProjectMatterClients } from "./project-matter-clients";
import { ProjectName } from "./project-name";
import { ProjectMetadata } from "./project-metadata";
import { ProjectNoteDialog } from "./project-note-dialog";
import { ProjectTaskDialog } from "./project-task-dialog";
import { UpcomingDeadlines } from "../calendar/upcoming-deadlines";
import { ProjectRecordings } from "./project-recordings";
import { recordingTranscriptTab } from "../recorder/recording-transcript-tabs";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { ProjectFilesDropzone } from "./project-files-dropzone";
import { useRecorderStore } from "../recorder/recorder-store";
import { ProjectNoteTile } from "./project-note-tile";
import { useProjectFavoritesStore } from "./project-favorites-store";
import { defaultProjectFields, useProjectDefaultsStore, withInitialProjectFields } from "./project-defaults-store";
import { t } from "@/i18n";
import { projectErrorMessage } from "./project-errors";
import { ProjectShareButton, ProjectSyncNotice } from "./project-sync";
import { deleteProjectNote } from "./delete-project-note";
import { noteTitle } from "./project-note-title";

async function saveProjectField(client: LegalworkServerClient, workspaceId: string, original: ProjectDetails, id: string,
  value: ProjectField["value"], previousSelection?: string[]) {
  const originalField = original.fields.find(field => field.id === id);
  let current = original;
  for (let attempt = 0; ; attempt++) {
    const field = current.fields.find(item => item.id === id);
    if (!field || !originalField || JSON.stringify({ ...field, value: null }) !== JSON.stringify({ ...originalField, value: null }))
      throw new LegalworkServerError(409, "project_changed", "This field definition changed.");
    let next = value;
    if (field.type === "backoffice" && field.multiple && previousSelection && (value === null || typeof value === "object")) {
      const directoryId = value?.directoryId ?? (originalField.type === "backoffice" ? originalField.value?.directoryId : undefined);
      if (field.value && field.value.directoryId !== directoryId)
        throw new LegalworkServerError(409, "project_reference_directory_changed", "The linked directory changed.");
      const currentIds = field.value?.recordIds ?? [], desired = value?.recordIds ?? [];
      const ids = [...new Set([...desired.filter(id => !previousSelection.includes(id) || currentIds.includes(id)), ...currentIds.filter(id => !previousSelection.includes(id))])];
      next = ids.length && directoryId ? { directoryId, recordIds: ids } : null;
    } else if (JSON.stringify(field.value) !== JSON.stringify(originalField.value) && JSON.stringify(field.value) !== JSON.stringify(value)) {
      throw new LegalworkServerError(409, "project_changed", "This field was edited by someone else.");
    }
    if (JSON.stringify(next) === JSON.stringify(field.value)) return current;
    try {
      return await client.updateProjectDetails(workspaceId, { revision: current.revision,
        fields: projectFieldsSchema.parse(current.fields.map(item => item.id === id ? { ...item, value: next } : item)) });
    } catch (error) {
      if (!(error instanceof LegalworkServerError) || error.code !== "project_changed" || attempt >= 3) throw error;
      current = await client.getProjectDetails(workspaceId);
    }
  }
}

export function ProjectHome(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  projectId: string;
  isRemoteWorkspace: boolean;
  inWorkspace: boolean;
  active: boolean;
  onStartRecording: () => void;
  name: string;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry) => void;
  onBeforeDeleteNote: (entry: LegalworkWorkspaceDirectoryEntry) => boolean;
  onNewSession: (shareRecording: boolean) => void | Promise<void>;
  tasksView: ReactNode;
  onViewAllDeadlines?: () => void;
  onRename?: (name: string) => Promise<boolean>;
}) {
  const { client, workspaceId } = props;
  const navigate = useNavigate();
  const requestTab = useRequestPanelTab({ kind: "workspace", workspaceId: props.projectId });
  const openRecordingTab = (recording: AudioRecordingMeta, preview = false) => requestTab(recordingTranscriptTab(recording), { preview, besideChat: true });
  const openRecording = (recording: AudioRecordingMeta) => openRecordingTab(recording, true);
  const openPersonalisation = useProjectPersonalisation();
  const recordingActive = useRecorderStore((state) => Boolean(state.recording && state.recording.id !== state.dictationRecordingId));
  const recordingStarting = useRecorderStore((state) => state.starting || Boolean(state.importing) || Boolean(state.recording && state.recording.id === state.dictationRecordingId));
  const recordingFinalizing = useRecorderStore((state) => state.finalizing);
  const recordLabel = t(recordingFinalizing ? "recorder.finishing" : recordingActive ? "recorder.stop_recording" : "recorder.record");
  const isFavorite = useProjectFavoritesStore((state) => state.favoriteIds.includes(workspaceId));
  const toggleFavorite = useProjectFavoritesStore((state) => state.toggleFavorite);
  const favoriteLabel = t(isFavorite ? "sidebar.unpin_project" : "sidebar.pin_project");
  const savedDefaults = useProjectDefaultsStore(defaultProjectFields);
  const queryClient = useQueryClient();
  const [noteOpen, setNoteOpen] = useState(false);
  const [deletingNote, setDeletingNote] = useState<LegalworkWorkspaceDirectoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [editMetadata, setEditMetadata] = useState<ProjectDetails | null>(null);
  useEffect(() => { setEditMetadata(null); }, [workspaceId, client.baseUrl]);
  const [sessionStarting, setSessionStarting] = useState(false);
  const newSession = async (shareRecording: boolean) => {
    if (sessionStarting) return;
    setSessionStarting(true);
    try { await props.onNewSession(shareRecording); }
    finally { setSessionStarting(false); }
  };
  const details = useQuery({
    queryKey: ["project", workspaceId],
    queryFn: () => client.getProjectDetails(workspaceId),
    select: (data) => withInitialProjectFields(data, savedDefaults),
  });
  const rootFiles = useQuery({
    queryKey: ["project-files", workspaceId, "", client.baseUrl],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, ""),
  });
  const hasNotes = Boolean(rootFiles.data?.entries.some((entry) => entry.kind === "dir" && entry.name === "Notes"));
  const notes = useQuery({
    queryKey: ["project-notes", workspaceId, client.baseUrl],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, "Notes"),
    enabled: hasNotes,
  });
  const noteEntries = (notes.data?.entries.filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.name)) ?? [])
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const refreshNotes = () => {
    void queryClient.invalidateQueries({ queryKey: ["project-files", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["project-notes", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
  };
  const deleteNote = async () => {
    if (!deletingNote || deleting) return;
    if (!props.onBeforeDeleteNote(deletingNote)) return;
    setDeleting(true);
    try {
      await deleteProjectNote(client, queryClient, workspaceId, deletingNote.path);
      setDeletingNote(null);
      toast.success(t("projects.note_deleted"));
    } catch {
      toast.error(t("projects.note_delete_failed"));
    } finally { setDeleting(false); }
  };

  return (
    <ProjectFilesDropzone projectId={props.projectId} workspaceId={workspaceId} isRemoteWorkspace={props.isRemoteWorkspace}>
    <div className="@container/project-page min-h-0 flex-1 overflow-y-auto" data-testid="project-home">
      <div className="lw-project-page-content lw-project-page-top space-y-6 pb-8">
        <div className="lw-project-home-header overflow-hidden rounded-2xl border border-border/60">
        <ContextMenu>
        <ContextMenuTrigger render={<header className="p-5 @min-[720px]/project-page:p-6" />}>
          <div className="flex flex-col items-stretch gap-3 @min-[680px]/project-page:flex-row @min-[680px]/project-page:items-start">
            <ProjectName name={props.name} onRename={props.onRename} />
            <div className="flex min-w-0 flex-wrap items-center gap-1 @min-[680px]/project-page:shrink-0">
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={favoriteLabel} aria-pressed={isFavorite} onClick={() => toggleFavorite(workspaceId)}><Pin className={cn("size-4", isFavorite && "fill-current text-foreground")} /></Button>} /><TooltipContent>{favoriteLabel}</TooltipContent></Tooltip>
            {props.isRemoteWorkspace ? null : <ProjectShareButton client={client} workspaceId={workspaceId} projectName={props.name} />}
            <Button variant="ghost" size="sm" className="shrink-0" aria-haspopup="dialog" onClick={() => openPersonalisation(props.projectId)}><WandSparkles />{t("personalisation.project_prompt_menu")}</Button>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            <div className="inline-flex rounded-xl shadow-xs">
              <Button size="lg" className={cn("h-10 min-w-36 rounded-xl shadow-none", recordingActive && "rounded-r-none")} disabled={sessionStarting || recordingFinalizing} title={recordingActive ? t("projects.new_chat_recording_on") : undefined} onClick={() => { void newSession(recordingActive); }}>
                {recordingActive ? <span aria-hidden="true" className="flex size-4 items-center justify-center"><span className="size-2.5 rounded-full bg-red-9" /></span> : <SquarePen strokeWidth={1.5} />}{t("projects.new_chat")}
                {recordingActive ? <span className="sr-only">{t("projects.new_chat_recording_on")}</span> : null}
              </Button>
              {recordingActive ? <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="lg" className="h-10 rounded-l-none rounded-r-xl border-l-background/20 px-2.5 shadow-none" disabled={sessionStarting || recordingFinalizing} aria-label={t("projects.new_chat_options")}><ChevronDown className="size-3.5" /></Button>} />
                <DropdownMenuContent align="end" className="w-auto">
                  <DropdownMenuItem onClick={() => { void newSession(false); }}><SquarePen strokeWidth={1.5} />{t("projects.new_chat_recording_off")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu> : null}
            </div>
            <Button variant="ghost" className="h-10 gap-1.5 rounded-xl px-3 text-xs" onClick={() => setNoteOpen(true)}><StickyNote />{t("projects.add_note")}</Button>
            <Button variant="ghost" className="h-10 gap-1.5 rounded-xl px-3 text-xs" onClick={() => setTaskOpen(true)}><SquareCheck />{t("tasks.new_task")}</Button>
            <Button variant="ghost" className="h-10 gap-1.5 rounded-xl px-3 text-xs" disabled={recordingStarting || recordingFinalizing} onClick={props.onStartRecording}>{recordingActive ? <Square className="text-red-9" fill="currentColor" /> : <Mic />}{recordLabel}</Button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={sessionStarting || recordingFinalizing} onClick={() => { void newSession(recordingActive); }}><SquarePen strokeWidth={1.5} />{t("projects.new_chat")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setNoteOpen(true)}><StickyNote />{t("projects.add_note")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setTaskOpen(true)}><SquareCheck />{t("tasks.new_task")}</ContextMenuItem>
          <ContextMenuItem disabled={recordingStarting || recordingFinalizing} onClick={props.onStartRecording}><Mic />{recordLabel}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => toggleFavorite(workspaceId)}><Pin />{favoriteLabel}</ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>

        {props.isRemoteWorkspace ? null : <ProjectSyncNotice client={client} workspaceId={workspaceId} onOpenFile={props.onOpenFile} />}

        <ProjectRemoteFolders client={client} workspaceId={workspaceId} />
        <ContextMenu>
        <ContextMenuTrigger render={<div />}>
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="border-t border-border/60 bg-background/60 px-5 py-1.5 @min-[720px]/project-page:px-6">
          <div className="flex items-center gap-2">
            <CollapsibleTrigger render={<Button variant="ghost" className="min-w-0 flex-1 justify-start gap-2 px-0 text-sm font-normal hover:bg-transparent aria-expanded:bg-transparent" />}>
              <ChevronRight className={cn("size-3.5 transition-transform", detailsOpen && "rotate-90")} />
              {t("projects.metadata")}
            </CollapsibleTrigger>
            <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => navigate(`/back-office/billing-settings?project=${encodeURIComponent(workspaceId)}`)}>
              {t("back_office.billing.settings")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={!details.data} onClick={() => setEditMetadata(details.data ?? null)}>
              <Settings2 className="size-3.5" />{t("projects.customize_connections")}
            </Button>
          </div>
          <CollapsibleContent>
            <div className="pb-3 pt-2">
              {details.isPending ? <Notice>{t("projects.loading")}</Notice> : details.error ? <Notice error>{t("projects.failed")}</Notice> : details.data?.fields.length ? (
                <ProjectProperties key={workspaceId} client={client} className="grid gap-x-10 space-y-0 @min-[640px]/project-page:grid-cols-2" fields={details.data.fields} onSave={async (id, value, previousSelection) => {
                  if (!details.data) return;
                  try {
                    const data = await saveProjectField(client, workspaceId, details.data, id, value, previousSelection);
                    queryClient.setQueryData(["project", workspaceId], data);
                  } catch (error) {
                    await details.refetch();
                    throw error;
                  }
                }} />
              ) : null}
              {details.data && <ProjectMatterClients client={client} fields={details.data.fields} />}
            </div>
          </CollapsibleContent>
        </Collapsible>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!details.data} onClick={() => setEditMetadata(details.data ?? null)}><Settings2 />{t("projects.customize_connections")}</ContextMenuItem>
          <ContextMenuItem onClick={() => setDetailsOpen(!detailsOpen)}><ChevronDown />{t(detailsOpen ? "projects.collapse_details" : "projects.expand_details")}</ContextMenuItem>
          <ContextMenuItem disabled={details.isFetching} onClick={() => { void details.refetch(); }}><RefreshCw />{t("common.refresh")}</ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>
        </div>

        {details.error || rootFiles.error ? <Surface className="space-y-3 rounded-xl p-4">
          <p role="alert" className="text-sm text-destructive">{projectErrorMessage(details.error ?? rootFiles.error)}</p>
          <Button variant="outline" size="sm" disabled={details.isFetching || rootFiles.isFetching} onClick={() => {
            void details.refetch();
            void rootFiles.refetch();
            void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
          }}>{t("workspace_files.try_again")}</Button>
        </Surface> : null}

        <div className="grid grid-cols-1 items-stretch gap-4 @min-[640px]/project-page:grid-cols-2">
          <div className="min-w-0">{props.tasksView}</div>
          <UpcomingDeadlines onViewAll={props.onViewAllDeadlines} client={client} workspaceId={workspaceId} projectId={props.projectId} projectName={props.name} />
        </div>

        <ContextMenu>
        <ContextMenuTrigger render={<section aria-label={t("projects.notes")} />}>
          <SectionHeading title={t("projects.notes")} action={<Button variant="ghost" size="icon-sm" aria-label={t("projects.add_note")} title={t("projects.add_note")} onClick={() => setNoteOpen(true)}><Plus className="size-4" /></Button>} />
          <div className="mt-3">
            {rootFiles.isPending || (hasNotes && notes.isPending) ? <Surface className="rounded-xl px-5"><Notice>{t("projects.loading")}</Notice></Surface>
              : notes.error || rootFiles.error ? <Surface className="rounded-xl px-5"><Notice error>{t("projects.failed")}</Notice></Surface>
              : noteEntries.length ? (
                <ul className="flex snap-x snap-proximity gap-3 overflow-x-auto overscroll-x-contain px-1 pb-3 pt-1" tabIndex={0} aria-label={t("projects.notes")}>
                  {noteEntries.map((entry) => (
                    <li key={entry.path} className="w-44 shrink-0 snap-start">
                      <ProjectNoteTile client={client} workspaceId={workspaceId} entry={entry} onOpen={() => props.onOpenFile(entry)} onDelete={() => setDeletingNote(entry)} />
                    </li>
                  ))}
                </ul>
              ) : (
                <Surface className="flex min-h-24 flex-wrap items-center gap-3 rounded-xl border-border/60 px-4 py-4 shadow-none">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-3/40 text-amber-11"><StickyNote className="size-4" /></span>
                  <p className="min-w-36 flex-1 text-xs leading-5 text-muted-foreground">{t("projects.no_notes")}</p>
                  <Button variant="ghost" size="sm" className="text-xs" onClick={() => setNoteOpen(true)}><Plus className="size-3.5" />{t("projects.add_note")}</Button>
                </Surface>
              )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setNoteOpen(true)}><Plus />{t("projects.add_note")}</ContextMenuItem>
          <ContextMenuItem disabled={rootFiles.isFetching || notes.isFetching} onClick={refreshNotes}><RefreshCw />{t("common.refresh")}</ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>

        <ProjectRecordings projectId={props.projectId} onStartRecording={props.onStartRecording} onOpenRecording={openRecording} onKeepRecordingOpen={recording => openRecordingTab(recording)} />
      </div>

      {noteOpen ? <ProjectNoteDialog client={client} workspaceId={workspaceId} onClose={() => setNoteOpen(false)} onSaved={refreshNotes} /> : null}
      <AlertDialog open={deletingNote !== null} onOpenChange={(open) => { if (!open && !deleting) setDeletingNote(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.delete_note")}</AlertDialogTitle>
            <AlertDialogDescription>{t("projects.delete_note_confirm", { name: deletingNote ? noteTitle(deletingNote.name) : "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting} onClick={() => { void deleteNote(); }}>{t("projects.delete_note")}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {taskOpen ? <ProjectTaskDialog client={client} workspaceId={workspaceId} onClose={() => setTaskOpen(false)} /> : null}
      <Dialog open={editMetadata !== null} onOpenChange={open => { if (!open) setEditMetadata(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{t("projects.customize_connections")}</DialogTitle><DialogDescription>{t("projects.customize_connections_hint")}</DialogDescription></DialogHeader>
          {editMetadata ? <ProjectMetadata client={client} details={editMetadata} onCancel={() => setEditMetadata(null)} onReload={async () => {
            const data = await client.getProjectDetails(workspaceId);
            queryClient.setQueryData(["project", workspaceId], data);
            const next = withInitialProjectFields(data, savedDefaults);
            setEditMetadata(next);
            return next;
          }} onSave={async (fields) => {
            const data = await client.updateProjectDetails(workspaceId, { revision: editMetadata.revision, fields });
            queryClient.setQueryData(["project", workspaceId], data);
            setEditMetadata(null);
          }} /> : null}
        </DialogContent>
      </Dialog>
    </div>
    </ProjectFilesDropzone>
  );
}

function Notice(props: { children: ReactNode; error?: boolean }) {
  return <p role={props.error ? "alert" : undefined} className={cn("py-4 text-sm leading-5", props.error ? "text-destructive" : "text-muted-foreground")}>{props.children}</p>;
}
