import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  FileText,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  Plus,
  RefreshCw,
  StickyNote,
} from "lucide-react";
import type {
  LegalworkServerClient,
  LegalworkWorkspaceDirectoryEntry,
} from "@/app/lib/legalwork-server";
import type { WorkspaceSessionGroup } from "@/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { cn } from "@/lib/utils";
import { requestOpenTask } from "../tasks/task-reference";
import { useTasks } from "../tasks/tasks-queries";
import { formatTaskDueDate } from "../tasks/task-format";
import { ProjectMetadata } from "./project-metadata";
import { ProjectNoteDialog } from "./project-note-dialog";
import { t } from "@/i18n";

export function ProjectHome(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  name: string;
  group?: WorkspaceSessionGroup;
  tasksView?: ReactNode;
  filesView: ReactNode;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry) => void;
  onSession: (id: string) => void;
  onNewSession: () => void;
}) {
  const { client, workspaceId } = props;
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab =
    requestedTab &&
    ["files", "tasks", "notes", "activity"].includes(requestedTab)
      ? requestedTab
      : "overview";
  const setTab = (value: string) =>
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === "overview") next.delete("tab");
      else next.set("tab", value);
      return next;
    });
  const [noteOpen, setNoteOpen] = useState(false);
  const [editMetadata, setEditMetadata] = useState(false);
  const details = useQuery({
    queryKey: ["project", workspaceId],
    queryFn: () => client.getProjectDetails(workspaceId),
  });
  const rootFiles = useQuery({
    queryKey: ["project-files", workspaceId, ""],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, ""),
  });
  const hasNotes = Boolean(
    rootFiles.data?.entries.some(
      (entry) => entry.kind === "dir" && entry.name === "Notes",
    ),
  );
  const notes = useQuery({
    queryKey: ["project-notes", workspaceId],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, "Notes"),
    enabled: hasNotes,
  });
  const tasks = useTasks(
    { client, workspaceId },
    { projectId: workspaceId, sort: "updated" },
  );
  const taskRows = tasks.data?.pages.flatMap((page) => page.tasks) ?? [];
  const openTasks = taskRows.filter(
    (task) => task.status !== "done" && task.status !== "cancelled",
  );
  const nextTask = [...openTasks]
    .filter((task) => task.dueDate)
    .sort(
      (a, b) => Date.parse(a.dueDate ?? "") - Date.parse(b.dueDate ?? ""),
    )[0];
  const sessions = (
    props.group?.sessions.filter(
      (session) => !session.time?.archived && !session.parentID,
    ) ?? []
  ).sort(
    (a, b) =>
      (b.time?.updated ?? b.time?.created ?? 0) -
      (a.time?.updated ?? a.time?.created ?? 0),
  );
  const noteEntries = (
    notes.data?.entries.filter(
      (entry) => entry.kind === "file" && /\.md$/i.test(entry.name),
    ) ?? []
  ).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const refresh = () => {
    void rootFiles.refetch();
    void tasks.refetch();
    void details.refetch();
    if (hasNotes) void notes.refetch();
  };
  const recent = [
    ...taskRows.map((task) => ({
      id: `task:${task.id}`,
      title: task.title,
      type: t("projects.task_updated"),
      at: Date.parse(task.updatedAt),
      icon: ListTodo,
      open: () => requestOpenTask(task.id, task.title),
    })),
    ...(rootFiles.data?.entries ?? [])
      .filter((entry) => entry.kind === "file" && !entry.name.startsWith("."))
      .concat(noteEntries)
      .map((entry) => ({
        id: `file:${entry.path}`,
        title: entry.path.startsWith("Notes/")
          ? noteTitle(entry.name)
          : entry.name,
        type: t(
          entry.path.startsWith("Notes/")
            ? "projects.note_updated"
            : "projects.file_updated",
        ),
        at: entry.updatedAt ?? 0,
        icon: FileText,
        open: () => props.onOpenFile(entry),
      })),
    ...sessions.map((session) => ({
      id: `session:${session.id}`,
      title: session.title,
      type: t("projects.session_updated"),
      at: session.time?.updated ?? session.time?.created ?? 0,
      icon: MessageSquare,
      open: () => props.onSession(session.id),
    })),
  ]
    .filter((item) => item.at > 0)
    .sort((a, b) => b.at - a.at);
  const tabs = [
    { id: "overview", label: t("projects.overview"), icon: LayoutDashboard },
    { id: "files", label: t("projects.files"), icon: FileText },
    { id: "tasks", label: t("projects.tasks"), icon: ListTodo },
    { id: "notes", label: t("projects.notes"), icon: StickyNote },
    { id: "activity", label: t("projects.activity"), icon: Activity },
  ];

  return (
    <div
      className="@container/project flex min-h-0 flex-1 overflow-hidden"
      data-testid="project-home"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @min-[760px]/project:flex-row @min-[760px]/project:overflow-hidden">
        <aside
          aria-label={t("projects.metadata")}
          className={cn(
            "shrink-0 border-b border-border/70 @min-[760px]/project:w-60 @min-[760px]/project:overflow-y-auto @min-[760px]/project:border-r @min-[760px]/project:border-b-0",
            tab !== "overview" && "hidden @min-[760px]/project:block",
          )}
        >
          <div className="space-y-4 border-b border-border/70 px-4 py-5">
            <div className="flex items-start gap-2.5">
              <FolderIcon className="mt-0.5 size-6 shrink-0" />
              <h1 className="min-w-0 flex-1 break-words text-base font-medium leading-6 tracking-tight">
                {props.name}
              </h1>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("projects.refresh")}
                onClick={refresh}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={props.onNewSession}
            >
              <MessageSquare />
              {t("projects.new_chat")}
            </Button>
          </div>
          <div className="px-4 py-4">
            <SectionHeading
              title={t("projects.metadata")}
              size="sidebar"
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!details.data}
                  onClick={() => setEditMetadata(true)}
                >
                  {t("projects.edit")}
                </Button>
              }
            />
            {details.isPending ? (
              <Notice>{t("projects.loading")}</Notice>
            ) : details.error ? (
              <Notice error>{t("projects.failed")}</Notice>
            ) : details.data?.fields.length ? (
              <dl className="mt-4 space-y-3.5">
                {details.data.fields.map((field) => (
                  <div
                    key={field.id}
                    className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-3 text-xs leading-5"
                  >
                    <dt className="break-words text-muted-foreground">
                      {field.label}
                    </dt>
                    <dd className="break-words">
                      {field.value === null || field.value === ""
                        ? t("projects.empty_value")
                        : String(field.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <Notice>{t("projects.no_metadata")}</Notice>
            )}
          </div>
        </aside>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (typeof value === "string") setTab(value);
          }}
          className="min-h-96 min-w-0 flex-1 gap-0 @min-[760px]/project:min-h-0"
        >
          <div className="shrink-0 overflow-x-auto border-b border-border/70 px-4">
            <TabsList
              variant="line"
              aria-label={t("projects.navigation")}
              className="h-11 gap-1"
            >
              {tabs.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  <item.icon className="size-3.5" />
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent
            value="overview"
            className="min-h-0 overflow-y-auto px-6 py-6"
          >
            <div className="mx-auto max-w-3xl space-y-7">
              <SectionHeading
                title={t("projects.overview")}
                description={t("projects.overview_hint")}
              />
              <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border">
                {[
                  {
                    label: t("projects.open_tasks"),
                    value: tasks.isPending
                      ? "–"
                      : `${openTasks.length}${tasks.hasNextPage ? "+" : ""}`,
                    target: "tasks",
                  },
                  {
                    label: t("projects.notes"),
                    value:
                      rootFiles.isPending || (hasNotes && notes.isPending)
                        ? "–"
                        : noteEntries.length,
                    target: "notes",
                  },
                  {
                    label: t("projects.sessions"),
                    value: sessions.length,
                    target: "activity",
                  },
                ].map((item) => (
                  <Button
                    key={item.label}
                    variant="ghost"
                    className="h-auto flex-col items-start gap-2 rounded-none px-4 py-4"
                    onClick={() => setTab(item.target)}
                  >
                    <span className="text-xs font-normal text-muted-foreground">
                      {item.label}
                    </span>
                    <span className="text-xl font-medium tabular-nums">
                      {item.value}
                    </span>
                  </Button>
                ))}
              </div>
              <div className="grid gap-4 @min-[1000px]/project:grid-cols-2">
                <Surface className="rounded-lg p-4">
                  <SectionHeading
                    size="sidebar"
                    title={t("projects.next_due_task")}
                  />
                  {nextTask ? (
                    <Button
                      variant="ghost"
                      className="mt-3 h-auto w-full justify-between gap-3 p-0 text-left hover:bg-transparent"
                      onClick={() =>
                        requestOpenTask(nextTask.id, nextTask.title)
                      }
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {nextTask.title}
                        </span>
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {formatTaskDueDate(nextTask.dueDate)}
                        </span>
                      </span>
                      <ArrowUpRight className="size-4 shrink-0" />
                    </Button>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {t("projects.no_due_task")}
                    </p>
                  )}
                </Surface>
                <Surface className="rounded-lg p-4">
                  <SectionHeading
                    size="sidebar"
                    title={t("projects.continue_session")}
                  />
                  {sessions[0] ? (
                    <Button
                      variant="ghost"
                      className="mt-3 h-auto w-full justify-between gap-3 p-0 text-left hover:bg-transparent"
                      onClick={() => props.onSession(sessions[0].id)}
                    >
                      <span className="truncate text-sm font-medium">
                        {sessions[0].title}
                      </span>
                      <ArrowUpRight className="size-4 shrink-0" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 -ml-2"
                      onClick={props.onNewSession}
                    >
                      <Plus />
                      {t("projects.new_chat")}
                    </Button>
                  )}
                </Surface>
              </div>
            </div>
          </TabsContent>
          <TabsContent
            value="files"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {props.filesView}
          </TabsContent>
          <TabsContent
            value="tasks"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {props.tasksView}
          </TabsContent>
          <TabsContent value="notes" className="min-h-0 overflow-y-auto">
            <div className="flex h-14 items-center justify-between border-b border-border/70 px-4">
              <h2 className="text-[15px] font-medium">{t("projects.notes")}</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("projects.add_note")}
                title={t("projects.add_note")}
                onClick={() => setNoteOpen(true)}
              >
                <Plus />
              </Button>
            </div>
            {rootFiles.isPending || (hasNotes && notes.isPending) ? (
              <div className="px-4">
                <Notice>{t("projects.loading")}</Notice>
              </div>
            ) : notes.error || rootFiles.error ? (
              <div className="px-4">
                <Notice error>{t("projects.failed")}</Notice>
              </div>
            ) : noteEntries.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">
                      {t("projects.note_title")}
                    </TableHead>
                    <TableHead className="text-right pr-4">
                      {t("projects.last_updated")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {noteEntries.map((entry) => (
                    <TableRow key={entry.path}>
                      <TableCell className="pl-4">
                        <Button
                          variant="ghost"
                          className="h-auto max-w-full justify-start gap-2 px-0 font-normal hover:bg-transparent"
                          onClick={() => props.onOpenFile(entry)}
                        >
                          <StickyNote className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">
                            {noteTitle(entry.name)}
                          </span>
                        </Button>
                      </TableCell>
                      <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                        {entry.updatedAt
                          ? new Date(entry.updatedAt).toLocaleDateString()
                          : "–"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <PanelEmptyState
                icon={<StickyNote />}
                title={t("projects.notes")}
                description={t("projects.no_notes")}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setNoteOpen(true)}
                >
                  <Plus />
                  {t("projects.add_note")}
                </Button>
              </PanelEmptyState>
            )}
          </TabsContent>
          <TabsContent
            value="activity"
            className="min-h-0 overflow-y-auto px-5 py-5"
          >
            <SectionHeading
              title={t("projects.activity")}
              description={t("projects.activity_hint")}
            />
            {recent.length ? (
              <Table className="mt-4">
                <TableBody>
                  {recent.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Button
                          variant="ghost"
                          className="h-auto w-full justify-start gap-3 px-0 text-left font-normal hover:bg-transparent"
                          onClick={item.open}
                        >
                          <item.icon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm">
                              {item.title}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {item.type}
                            </span>
                          </span>
                        </Button>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {new Date(item.at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <PanelEmptyState
                icon={<Activity />}
                title={t("projects.activity")}
                description={t("projects.no_activity")}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
      {noteOpen ? (
        <ProjectNoteDialog
          client={client}
          workspaceId={workspaceId}
          onClose={() => setNoteOpen(false)}
          onSaved={() => {
            void queryClient.invalidateQueries({
              queryKey: ["project-files", workspaceId],
            });
            void queryClient.invalidateQueries({
              queryKey: ["project-notes", workspaceId],
            });
            setTab("notes");
          }}
        />
      ) : null}
      <Dialog open={editMetadata} onOpenChange={setEditMetadata}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("projects.metadata")}</DialogTitle>
            <DialogDescription>{t("projects.metadata_hint")}</DialogDescription>
          </DialogHeader>
          {details.data ? (
            <ProjectMetadata
              details={details.data}
              onCancel={() => setEditMetadata(false)}
              onSave={async (fields) => {
                if (!details.data) return;
                const data = await client.updateProjectDetails(workspaceId, {
                  revision: details.data.revision,
                  fields,
                });
                queryClient.setQueryData(["project", workspaceId], data);
                setEditMetadata(false);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function noteTitle(name: string) {
  return name.replace(/-[a-f0-9]{8}\.md$/i, "").replace(/\.md$/i, "");
}
function Notice(props: { children: ReactNode; error?: boolean }) {
  return (
    <p
      role={props.error ? "alert" : undefined}
      className={`py-4 text-xs leading-5 ${props.error ? "text-destructive" : "text-muted-foreground"}`}
    >
      {props.children}
    </p>
  );
}
