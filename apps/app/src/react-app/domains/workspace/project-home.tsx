import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, ListTodo, MessageSquare, Mic, Plus, Settings2, Pencil, Star, StickyNote, SquareCheck } from "lucide-react";
import type { LegalworkServerClient, LegalworkWorkspaceDirectoryEntry } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { useTasks } from "../tasks/tasks-queries";
import { ProjectProperties } from "./project-properties";
import { ProjectMetadata } from "./project-metadata";
import { ProjectNoteDialog } from "./project-note-dialog";
import { ProjectTaskDialog } from "./project-task-dialog";
import { ProjectRecordings } from "./project-recordings";
import { useRecorderStore } from "../recorder/recorder-store";
import { noteTitle } from "./project-note-title";
import { useProjectFavoritesStore } from "./project-favorites-store";
import { defaultAkteFields, useProjectDefaultsStore, withInitialProjectFields } from "./project-defaults-store";
import { currentLocale, t } from "@/i18n";

export function ProjectHome(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  recordingProjectId: string;
  onStartRecording: () => void;
  name: string;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry) => void;
  onNewSession: () => void;
  onOpenTasks: () => void;
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
  const tasks = useTasks({ client, workspaceId }, { projectId: workspaceId, sort: "updated" });
  const openTasks = (tasks.data?.pages.flatMap((page) => page.tasks) ?? []).filter((task) => task.status !== "done" && task.status !== "cancelled");
  const noteEntries = (notes.data?.entries.filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.name)) ?? [])
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

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
          <Surface className="mt-3 overflow-hidden rounded-xl">
            {rootFiles.isPending || (hasNotes && notes.isPending) ? <div className="px-5"><Notice>{t("projects.loading")}</Notice></div>
              : notes.error || rootFiles.error ? <div className="px-5"><Notice error>{t("projects.failed")}</Notice></div>
              : noteEntries.length ? (
                <ul className="divide-y divide-border/60">
                  {noteEntries.map((entry) => (
                    <li key={entry.path}>
                      <Button variant="ghost" className="group/note h-auto w-full justify-start gap-3 rounded-none px-4 py-4 text-left font-normal text-foreground" aria-label={noteTitle(entry.name)} onClick={() => props.onOpenFile(entry)}>
                        <StickyNote className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">{noteTitle(entry.name)}</span>
                        {entry.updatedAt ? <time dateTime={new Date(entry.updatedAt).toISOString()} className="shrink-0 text-xs text-muted-foreground">{new Date(entry.updatedAt).toLocaleDateString(currentLocale())}</time> : null}
                        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/note:opacity-100 group-focus-visible/note:opacity-100" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col items-center px-6 py-10 text-center">
                  <StickyNote className="mb-3 size-5 text-muted-foreground/70" />
                  <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("projects.no_notes")}</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => setNoteOpen(true)}><Plus className="size-4" />{t("projects.add_note")}</Button>
                </div>
              )}
          </Surface>
        </section>

        <ProjectRecordings projectId={props.recordingProjectId} onRecord={props.onStartRecording} />

        <Button variant="ghost" className="mt-6 h-auto w-full justify-start gap-3 rounded-xl border border-border/70 px-4 py-4 text-left font-normal text-foreground" onClick={props.onOpenTasks}>
          <ListTodo className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm font-medium">{t("projects.tasks")}</span>
          <span className="text-xs text-muted-foreground">{t("projects.open_tasks")}{!tasks.isPending && !tasks.error ? ` · ${openTasks.length}${tasks.hasNextPage ? "+" : ""}` : ""}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </div>

      {noteOpen ? <ProjectNoteDialog client={client} workspaceId={workspaceId} onClose={() => setNoteOpen(false)} onSaved={() => {
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
