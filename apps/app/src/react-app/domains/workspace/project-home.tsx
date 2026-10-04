import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Link2, MessageSquare, Mic, Plus, RefreshCw, Settings2, Square, Star, StickyNote, SquareCheck } from "lucide-react";
import type { LegalworkServerClient, LegalworkWorkspaceDirectoryEntry } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/sonner";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { ProjectProperties } from "./project-properties";
import { ProjectRecordings } from "./project-recordings";
import { ProjectFilesDropzone } from "./project-files-dropzone";
import { useRecorderStore } from "../recorder/recorder-store";
import { ProjectNoteTile } from "./project-note-tile";
import { useProjectFavoritesStore } from "./project-favorites-store";
import { defaultAkteFields, useProjectDefaultsStore, withInitialProjectFields } from "./project-defaults-store";
import { t } from "@/i18n";
import { projectErrorMessage } from "./project-errors";
import { ProjectShareButton, ProjectSyncNotice } from "./project-sync";
import { deleteProjectNote } from "./delete-project-note";
import { noteTitle } from "./project-note-title";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import { ProjectMenu, ProjectContextMenu } from "./project-menu";
import { useProjectControls } from "./project-controls";

export function ProjectHome(props: {
  client: LegalworkServerClient;
  workspace: WorkspaceInfo;
  workspaceId: string;
  projectId: string;
  isRemoteWorkspace: boolean;
  onStartRecording: () => void;
  name: string;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry) => void;
  onBeforeDeleteNote: (entry: LegalworkWorkspaceDirectoryEntry) => boolean;
  onNewSession: (shareRecording: boolean) => void | Promise<void>;
  tasksView: ReactNode;
}) {
  const { client, workspaceId } = props;
  const controls = useProjectControls();
  const recordingActive = useRecorderStore((state) => Boolean(state.recording && state.recording.id !== state.dictationRecordingId));
  const recordingStarting = useRecorderStore((state) => state.starting || Boolean(state.importing) || Boolean(state.recording && state.recording.id === state.dictationRecordingId));
  const recordingFinalizing = useRecorderStore((state) => state.finalizing);
  const recordLabel = t(recordingFinalizing ? "recorder.finishing" : recordingActive ? "recorder.stop_recording" : "recorder.record");
  const isFavorite = useProjectFavoritesStore((state) => state.favoriteIds.includes(props.projectId));
  const toggleFavorite = useProjectFavoritesStore((state) => state.toggleFavorite);
  const favoriteLabel = t(isFavorite ? "projects.remove_favorite" : "projects.add_favorite");
  const savedDefaults = useProjectDefaultsStore((state) => state.fields);
  const queryClient = useQueryClient();
  const [deletingNote, setDeletingNote] = useState<LegalworkWorkspaceDirectoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
    select: (data) => withInitialProjectFields(data, savedDefaults ?? defaultAkteFields()),
  });
  const rootFiles = useQuery({
    queryKey: ["project-files", workspaceId, ""],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, ""),
  });
  const hasNotes = Boolean(rootFiles.data?.entries.some((entry) => entry.kind === "dir" && entry.name === "Notes"));
  const notes = useQuery({
    queryKey: ["project-notes", workspaceId],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, "Notes"),
    enabled: hasNotes,
  });
  const noteEntries = (notes.data?.entries.filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.name)) ?? [])
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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
        <ProjectContextMenu workspace={props.workspace}>
        <header className="p-5 @min-[720px]/project-page:p-6">
          <div className="flex items-start gap-1">
            <h1 className="min-w-0 flex-1 break-words text-2xl font-semibold leading-tight tracking-tight">{props.name}</h1>
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={favoriteLabel} aria-pressed={isFavorite} onClick={() => toggleFavorite(props.projectId)}><Star className={cn("size-4", isFavorite && "fill-current text-foreground")} /></Button>} /><TooltipContent>{favoriteLabel}</TooltipContent></Tooltip>
            {props.isRemoteWorkspace ? null : <ProjectShareButton client={client} workspaceId={workspaceId} onOpen={() => controls.openSettings(props.workspace, "sharing")} />}
            <ProjectMenu workspace={props.workspace} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            <div className="inline-flex rounded-xl shadow-xs">
              <Button size="lg" className={cn("h-10 min-w-36 rounded-xl shadow-none", recordingActive && "rounded-r-none")} disabled={sessionStarting || recordingFinalizing} title={recordingActive ? t("projects.new_chat_recording_on") : undefined} onClick={() => { void newSession(recordingActive); }}>
                {recordingActive ? <span aria-hidden="true" className="flex size-4 items-center justify-center"><span className="size-2.5 rounded-full bg-red-9" /></span> : <MessageSquare />}{t("projects.new_chat")}
                {recordingActive ? <span className="sr-only">{t("projects.new_chat_recording_on")}</span> : null}
              </Button>
              {recordingActive ? <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="lg" className="h-10 rounded-l-none rounded-r-xl border-l-background/20 px-2.5 shadow-none" disabled={sessionStarting || recordingFinalizing} aria-label={t("projects.new_chat_options")}><ChevronDown className="size-3.5" /></Button>} />
                <DropdownMenuContent align="end" className="w-auto">
                  <DropdownMenuItem onClick={() => { void newSession(false); }}><MessageSquare />{t("projects.new_chat_recording_off")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu> : null}
            </div>
            <Button variant="ghost" className="h-10 gap-1.5 rounded-xl px-3 text-xs" onClick={() => controls.create(props.workspace, "note")}><StickyNote />{t("projects.add_note")}</Button>
            <Button variant="ghost" className="h-10 gap-1.5 rounded-xl px-3 text-xs" onClick={() => controls.create(props.workspace, "task")}><SquareCheck />{t("tasks.new_task")}</Button>
            <Button variant="ghost" className="h-10 gap-1.5 rounded-xl px-3 text-xs" disabled={recordingStarting || recordingFinalizing} onClick={props.onStartRecording}>{recordingActive ? <Square className="text-red-9" fill="currentColor" /> : <Mic />}{recordLabel}</Button>
          </div>
        </header>
        </ProjectContextMenu>

        {props.isRemoteWorkspace ? null : <ProjectSyncNotice client={client} workspaceId={workspaceId} onOpenFile={props.onOpenFile} />}

        <div className="border-t border-border/60 px-5 py-2 @min-[720px]/project-page:px-6">
          <Button variant="ghost" size="sm" onClick={() => controls.openSettings(props.workspace, "folders")}><Link2 />{t("projects.remote.linked")} {details.data?.remote?.folders.length || ""}</Button>
        </div>

        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="border-t border-border/60 bg-background/60 px-5 py-1.5 @min-[720px]/project-page:px-6">
          <div className="flex items-center gap-2">
            <CollapsibleTrigger render={<Button variant="ghost" className="min-w-0 flex-1 justify-start gap-2 px-0 text-sm font-normal hover:bg-transparent aria-expanded:bg-transparent" />}>
              <ChevronRight className={cn("size-3.5 transition-transform", detailsOpen && "rotate-90")} />
              {t("projects.metadata")}
            </CollapsibleTrigger>
            <Button size="icon-xs" variant="ghost" disabled={!details.data} aria-label={t("projects.configure_fields")} title={t("projects.configure_fields")} onClick={() => controls.openSettings(props.workspace, "fields")}><Settings2 className="size-3.5" /></Button>
          </div>
          <CollapsibleContent>
            <div className="pb-3 pt-2">
              {details.isPending ? <Notice>{t("projects.loading")}</Notice> : details.error ? <Notice error>{t("projects.failed")}</Notice> : details.data?.fields.length ? (
                <ProjectProperties className="grid gap-x-10 space-y-0 @min-[640px]/project-page:grid-cols-2" fields={details.data.fields} onSave={async (id, value) => {
                  if (!details.data) return;
                  try {
                    const data = await client.updateProjectDetails(workspaceId, { revision: details.data.revision, fields: details.data.fields.map((field) => field.id === id ? { ...field, value } : field) });
                    queryClient.setQueryData(["project", workspaceId], data);
                  } catch (error) {
                    void details.refetch();
                    throw error;
                  }
                }} />
              ) : <Notice>{t("projects.no_metadata")}</Notice>}
            </div>
          </CollapsibleContent>
        </Collapsible>

        </div>

        {details.error || rootFiles.error ? <Surface className="space-y-3 rounded-xl p-4">
          <p role="alert" className="text-sm text-destructive">{projectErrorMessage(details.error ?? rootFiles.error)}</p>
          <Button variant="outline" size="sm" disabled={details.isFetching || rootFiles.isFetching} onClick={() => {
            void details.refetch();
            void rootFiles.refetch();
            void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
          }}>{t("workspace_files.try_again")}</Button>
        </Surface> : null}

        <ContextMenu>
        <ContextMenuTrigger render={<section aria-label={t("projects.notes")} />}>
          <SectionHeading title={t("projects.notes")} action={<Button variant="ghost" size="icon-sm" aria-label={t("projects.add_note")} title={t("projects.add_note")} onClick={() => controls.create(props.workspace, "note")}><Plus className="size-4" /></Button>} />
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
                  <Button variant="ghost" size="sm" className="text-xs" onClick={() => controls.create(props.workspace, "note")}><Plus className="size-3.5" />{t("projects.add_note")}</Button>
                </Surface>
              )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => controls.create(props.workspace, "note")}><Plus />{t("projects.add_note")}</ContextMenuItem>
          <ContextMenuItem disabled={rootFiles.isFetching || notes.isFetching} onClick={() => {
            for (const key of ["project-files", "project-notes", "workspace-files"]) void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
          }}><RefreshCw />{t("common.refresh")}</ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>

        <div>{props.tasksView}</div>

        <ProjectRecordings projectId={props.projectId} onStartRecording={props.onStartRecording} />
      </div>

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

    </div>
    </ProjectFilesDropzone>
  );
}

function Notice(props: { children: ReactNode; error?: boolean }) {
  return <p role={props.error ? "alert" : undefined} className={cn("py-4 text-sm leading-5", props.error ? "text-destructive" : "text-muted-foreground")}>{props.children}</p>;
}
