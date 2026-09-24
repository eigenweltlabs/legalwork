import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MessageSquare, Mic, Plus, Settings2, Pencil, Star, StickyNote, SquareCheck } from "lucide-react";
import type { LegalworkServerClient, LegalworkWorkspaceDirectoryEntry } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { ListPagination } from "@/components/list-pagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { ProjectProperties } from "./project-properties";
import { ProjectMetadata } from "./project-metadata";
import { ProjectNoteDialog } from "./project-note-dialog";
import { ProjectTaskDialog } from "./project-task-dialog";
import { ProjectRecordings } from "./project-recordings";
import { useRecorderStore } from "../recorder/recorder-store";
import { ProjectNoteTile } from "./project-note-tile";
import { useProjectFavoritesStore } from "./project-favorites-store";
import { defaultAkteFields, useProjectDefaultsStore, withInitialProjectFields } from "./project-defaults-store";
import { t } from "@/i18n";

const NOTES_PER_PAGE = 6;

export function ProjectHome(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  recordingProjectId: string;
  onStartRecording: () => void;
  name: string;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry) => void;
  onNewSession: () => void;
  tasksView: ReactNode;
  onRename: () => void;
}) {
  const { client, workspaceId } = props;
  const recordingActive = useRecorderStore((state) => Boolean(state.recording));
  const recordingStarting = useRecorderStore((state) => state.starting || Boolean(state.importing));
  const recordLabel = t(recordingActive ? "recorder.open" : "recorder.record");
  const isFavorite = useProjectFavoritesStore((state) => state.favoriteIds.includes(workspaceId));
  const toggleFavorite = useProjectFavoritesStore((state) => state.toggleFavorite);
  const favoriteLabel = t(isFavorite ? "projects.remove_favorite" : "projects.add_favorite");
  const savedDefaults = useProjectDefaultsStore((state) => state.fields);
  const queryClient = useQueryClient();
  const [noteOpen, setNoteOpen] = useState(false);
  const [notePage, setNotePage] = useState(0);
  const [taskOpen, setTaskOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editMetadata, setEditMetadata] = useState(false);
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
  const currentNotePage = Math.min(notePage, Math.max(0, Math.ceil(noteEntries.length / NOTES_PER_PAGE) - 1));
  const visibleNotes = noteEntries.slice(currentNotePage * NOTES_PER_PAGE, (currentNotePage + 1) * NOTES_PER_PAGE);

  return (
    <div className="@container/project min-h-0 flex-1 overflow-y-auto" data-testid="project-home">
      <div className="mx-auto w-full max-w-4xl px-6 py-8 @min-[720px]/project:px-12 @min-[720px]/project:py-10">
        <header className="mb-8">
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 flex-1 break-words text-2xl font-semibold leading-tight tracking-tight">{props.name}</h1>
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t("workspace.rename_title")} onClick={props.onRename}><Pencil className="size-4" /></Button>} /><TooltipContent>{t("workspace.rename_title")}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={favoriteLabel} aria-pressed={isFavorite} onClick={() => toggleFavorite(workspaceId)}><Star className={cn("size-4", isFavorite && "fill-current text-foreground")} /></Button>} /><TooltipContent>{favoriteLabel}</TooltipContent></Tooltip>
          </div>
          <div className="mt-5 flex items-center gap-2">
            <Button variant="outline" className="rounded-xl shadow-xs" onClick={props.onNewSession}><MessageSquare />{t("projects.new_chat")}</Button>
            <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon" className="rounded-xl shadow-xs" aria-label={t("projects.add_note")} onClick={() => setNoteOpen(true)}><StickyNote /></Button>} /><TooltipContent>{t("projects.add_note")}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon" className="rounded-xl shadow-xs" aria-label={t("tasks.new_task")} onClick={() => setTaskOpen(true)}><SquareCheck /></Button>} /><TooltipContent>{t("tasks.new_task")}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon" className="rounded-xl shadow-xs" disabled={recordingStarting} aria-label={recordLabel} onClick={props.onStartRecording}><Mic /></Button>} /><TooltipContent>{recordLabel}</TooltipContent></Tooltip>
          </div>
        </header>

        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mb-8 border-y border-border/70 py-2">
          <div className="flex items-center gap-2">
            <CollapsibleTrigger render={<Button variant="ghost" className="min-w-0 flex-1 justify-start gap-2 px-0 text-sm font-normal hover:bg-transparent" />}>
              <ChevronRight className={cn("size-3.5 transition-transform", detailsOpen && "rotate-90")} />
              {t("projects.metadata")}
            </CollapsibleTrigger>
            <Button size="icon-xs" variant="ghost" disabled={!details.data} aria-label={t("projects.configure_fields")} title={t("projects.configure_fields")} onClick={() => setEditMetadata(true)}><Settings2 className="size-3.5" /></Button>
          </div>
          <CollapsibleContent>
            <div className="pb-3 pt-2">
              {details.isPending ? <Notice>{t("projects.loading")}</Notice> : details.error ? <Notice error>{t("projects.failed")}</Notice> : details.data?.fields.length ? (
                <ProjectProperties className="grid gap-x-10 space-y-0 @min-[640px]/project:grid-cols-2" fields={details.data.fields} onSave={async (id, value) => {
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

        <section aria-label={t("projects.notes")}>
          <SectionHeading title={t("projects.notes")} action={<Button variant="ghost" size="icon-sm" aria-label={t("projects.add_note")} title={t("projects.add_note")} onClick={() => setNoteOpen(true)}><Plus className="size-4" /></Button>} />
          <div className="mt-3">
            {rootFiles.isPending || (hasNotes && notes.isPending) ? <Surface className="rounded-xl px-5"><Notice>{t("projects.loading")}</Notice></Surface>
              : notes.error || rootFiles.error ? <Surface className="rounded-xl px-5"><Notice error>{t("projects.failed")}</Notice></Surface>
              : noteEntries.length ? (
                <>
                  <ul className="grid grid-cols-1 gap-3 @min-[400px]/project:grid-cols-2 @min-[720px]/project:grid-cols-3">
                    {visibleNotes.map((entry) => (
                      <li key={entry.path} className="min-w-0">
                        <ProjectNoteTile client={client} workspaceId={workspaceId} entry={entry} onOpen={() => props.onOpenFile(entry)} />
                      </li>
                    ))}
                  </ul>
                  <ListPagination label={t("projects.notes_pagination")} page={currentNotePage} pageSize={NOTES_PER_PAGE} total={noteEntries.length} onPageChange={setNotePage} className="mt-1 px-0" />
                </>
              ) : (
                <Surface className="flex flex-col items-center rounded-xl px-6 py-10 text-center">
                  <StickyNote className="mb-3 size-5 text-muted-foreground/70" />
                  <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("projects.no_notes")}</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => setNoteOpen(true)}><Plus className="size-4" />{t("projects.add_note")}</Button>
                </Surface>
              )}
          </div>
        </section>

        <ProjectRecordings projectId={props.recordingProjectId} onRecord={props.onStartRecording} />

        <div className="mt-8">{props.tasksView}</div>
      </div>

      {noteOpen ? <ProjectNoteDialog client={client} workspaceId={workspaceId} onClose={() => setNoteOpen(false)} onSaved={() => {
        setNotePage(0);
        void queryClient.invalidateQueries({ queryKey: ["project-files", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["project-notes", workspaceId] });
      }} /> : null}
      {taskOpen ? <ProjectTaskDialog client={client} workspaceId={workspaceId} onClose={() => setTaskOpen(false)} /> : null}
      <Dialog open={editMetadata} onOpenChange={setEditMetadata}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{t("projects.metadata")}</DialogTitle><DialogDescription>{t("projects.metadata_hint")}</DialogDescription></DialogHeader>
          {details.data ? <ProjectMetadata details={details.data} onCancel={() => setEditMetadata(false)} onSave={async (fields) => {
            if (!details.data) return;
            const data = await client.updateProjectDetails(workspaceId, { revision: details.data.revision, fields });
            queryClient.setQueryData(["project", workspaceId], data);
            setEditMetadata(false);
          }} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Notice(props: { children: ReactNode; error?: boolean }) {
  return <p role={props.error ? "alert" : undefined} className={cn("py-4 text-sm leading-5", props.error ? "text-destructive" : "text-muted-foreground")}>{props.children}</p>;
}
