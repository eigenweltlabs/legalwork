import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  LayoutDashboard,
  Mail,
  StickyNote,
  Table2,
  ListTodo,
  ArrowLeft,
  CheckCircle2,
  Circle,
  FileText,
  MessageSquare,
  Plus,
  RefreshCw,
  Unlink,
} from "lucide-react";
import type {
  LegalworkServerClient,
  LegalworkTaskPatch,
  LegalworkWorkspaceDirectoryEntry,
} from "@/app/lib/legalwork-server";
import type { WorkspaceSessionGroup } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectNoteDialog } from "./project-note-dialog";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { SectionHeading, Surface } from "../../design-system/surface";
import { FolderIcon } from "../../design-system/folder-icon";
import { useTasks } from "../tasks/tasks-queries";
import { useShowTasksPane } from "../../shell/show-tasks-pane";
import { ProjectMetadata } from "./project-metadata";
import { t } from "@/i18n";

export function ProjectHome(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  name: string;
  folder: string;
  group?: WorkspaceSessionGroup;
  onFiles: () => void;
  onOpenFile: (entry: LegalworkWorkspaceDirectoryEntry) => void;
  onSession: (id: string) => void;
  onNewSession: () => void;
}) {
  const { client, workspaceId } = props;
  const queryClient = useQueryClient();
  const showTask = useShowTasksPane();
  const [directory, setDirectory] = useState("");
  const [tab, setTab] = useState("overview");
  const [noteOpen, setNoteOpen] = useState(false);
  const [editMetadata, setEditMetadata] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const details = useQuery({
    queryKey: ["project", workspaceId],
    queryFn: () => client.getProjectDetails(workspaceId),
  });
  const files = useQuery({
    queryKey: ["project-files", workspaceId, directory],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, directory),
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
  const invalidateTasks = () =>
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
  const mutateTask = async (id: string, patch: LegalworkTaskPatch) => {
    setBusy(true);
    try {
      await client.patchTask(workspaceId, id, patch);
      await invalidateTasks();
      await queryClient.invalidateQueries({ queryKey: ["task"] });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("projects.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const createTask = async () => {
    if (!taskTitle.trim()) return;
    setBusy(true);
    try {
      await client.createTask(workspaceId, {
        title: taskTitle.trim(),
        projectId: workspaceId,
      });
      setTaskTitle("");
      await invalidateTasks();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("projects.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const taskRows = tasks.data?.pages.flatMap((page) => page.tasks) ?? [];
  const sessions =
    props.group?.sessions.filter(
      (session) => !session.time?.archived && !session.parentID,
    ) ?? [];
  const entries =
    files.data?.entries.filter((entry) => !entry.name.startsWith(".")) ?? [];
  const refresh = () => {
    void files.refetch();
    void tasks.refetch();
    void details.refetch();
    void rootFiles.refetch();
    if (hasNotes) void notes.refetch();
  };
  const noteEntries =
    notes.data?.entries.filter(
      (entry) => entry.kind === "file" && entry.name.endsWith(".md"),
    ) ?? [];
  const recent = [
    ...taskRows.map((task) => ({
      id: `task:${task.id}`,
      title: task.title,
      type: t("projects.task_updated"),
      at: Date.parse(task.updatedAt),
      icon: ListTodo,
      open: () => showTask(task.id),
    })),
    ...(rootFiles.data?.entries ?? [])
      .filter((entry) => entry.kind === "file" && !entry.name.startsWith("."))
      .concat(noteEntries)
      .map((entry) => ({
        id: `file:${entry.path}`,
        title: entry.name,
        type: entry.path.startsWith("Notes/")
          ? t("projects.note_updated")
          : t("projects.file_updated"),
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
  const taskSection = (
    <section>
      <SectionHeading
        title={t("projects.tasks")}
        description={t("projects.tasks_hint")}
        action={
          <Button variant="ghost" size="sm" onClick={() => setLinkOpen(true)}>
            {t("projects.link_task")}
          </Button>
        }
      />
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void createTask();
        }}
      >
        <Input
          aria-label={t("projects.new_task")}
          placeholder={t("projects.new_task")}
          maxLength={500}
          value={taskTitle}
          disabled={busy}
          onChange={(event) => setTaskTitle(event.target.value)}
        />
        <Button
          type="submit"
          size="icon"
          aria-label={t("projects.add_task")}
          disabled={busy || !taskTitle.trim()}
        >
          <Plus className="size-4" />
        </Button>
      </form>
      {tasks.isPending ? (
        <Notice>{t("projects.loading")}</Notice>
      ) : tasks.error ? (
        <Notice error>{t("projects.failed")}</Notice>
      ) : taskRows.length ? (
        <ul className="mt-3 divide-y divide-border">
          {taskRows.map((task) => (
            <li key={task.id} className="flex items-center gap-2 py-2">
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={
                  task.status === "done"
                    ? t("projects.reopen_task")
                    : t("projects.complete_task")
                }
                onClick={() =>
                  void mutateTask(task.id, {
                    status: task.status === "done" ? "open" : "done",
                  })
                }
              >
                {task.status === "done" ? (
                  <CheckCircle2 className="size-4 text-muted-foreground" />
                ) : (
                  <Circle className="size-4 text-muted-foreground" />
                )}
              </Button>
              <button
                className="min-w-0 flex-1 text-left text-sm hover:underline"
                onClick={() => showTask(task.id)}
              >
                <span
                  className={
                    task.status === "done"
                      ? "text-muted-foreground line-through"
                      : ""
                  }
                >
                  {task.title}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("projects.unlink_task", {
                  name: task.title,
                })}
                disabled={busy}
                onClick={() => void mutateTask(task.id, { projectId: null })}
              >
                <Unlink className="size-3.5 text-muted-foreground" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>{t("projects.no_tasks")}</Notice>
      )}
      {tasks.hasNextPage ? (
        <Button
          variant="ghost"
          disabled={tasks.isFetchingNextPage}
          onClick={() => void tasks.fetchNextPage()}
        >
          {t("projects.more")}
        </Button>
      ) : null}
    </section>
  );
  const fileSection = (
    <section>
      <SectionHeading
        title={t("projects.files")}
        description={t("projects.documents_hint")}
        action={
          <Button variant="ghost" size="sm" onClick={props.onFiles}>
            {t("projects.all_files")}
          </Button>
        }
      />
      {directory ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 max-w-full"
          onClick={() =>
            setDirectory(directory.split("/").slice(0, -1).join("/"))
          }
        >
          <ArrowLeft className="size-4" />
          <span className="truncate">{directory}</span>
        </Button>
      ) : null}
      {files.isPending ? (
        <Notice>{t("projects.loading")}</Notice>
      ) : files.error ? (
        <Notice error>{t("projects.failed")}</Notice>
      ) : entries.length ? (
        <ul className="mt-3 divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                className="flex w-full items-center gap-3 rounded-lg px-1 py-3 text-left text-sm hover:bg-muted/50"
                onClick={() =>
                  entry.kind === "dir"
                    ? setDirectory(entry.path)
                    : props.onOpenFile(entry)
                }
              >
                {entry.kind === "dir" ? (
                  <FolderIcon className="size-5" />
                ) : (
                  <FileText className="size-5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>{t("projects.no_documents")}</Notice>
      )}
      {files.data?.truncated ? (
        <Notice>{t("projects.files_truncated")}</Notice>
      ) : null}
    </section>
  );
  const sessionSection = (
    <section>
      <SectionHeading
        title={t("projects.sessions")}
        action={
          <Button size="sm" variant="ghost" onClick={props.onNewSession}>
            <Plus className="size-4" />
            {t("projects.new_chat")}
          </Button>
        }
      />
      {props.group?.status === "error" ? (
        <Notice error>{t("projects.failed")}</Notice>
      ) : props.group?.status === "loading" ||
        props.group?.status === "idle" ? (
        <Notice>{t("projects.loading")}</Notice>
      ) : sessions.length ? (
        <ul className="mt-3 divide-y divide-border">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                className="flex w-full items-start gap-3 rounded-lg py-3 text-left text-sm hover:bg-muted/50"
                onClick={() => props.onSession(session.id)}
              >
                <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="break-words">{session.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>{t("projects.no_sessions")}</Notice>
      )}
    </section>
  );
  const activitySection = (
    <section>
      <SectionHeading
        title={t("projects.activity")}
        description={t("projects.activity_hint")}
      />
      {recent.length ? (
        <div className="mt-4 divide-y divide-border rounded-xl border border-border">
          {recent.slice(0, tab === "overview" ? 5 : 30).map((item) => (
            <button
              key={item.id}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
              onClick={item.open}
            >
              <item.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.title}</span>
                <span className="text-xs text-muted-foreground">
                  {item.type}
                </span>
              </span>
              <time
                className="shrink-0 text-xs text-muted-foreground"
                dateTime={new Date(item.at).toISOString()}
              >
                {new Date(item.at).toLocaleDateString()}
              </time>
            </button>
          ))}
        </div>
      ) : (
        <Notice>{t("projects.no_activity")}</Notice>
      )}
    </section>
  );
  const notesSection = (
    <section>
      <SectionHeading
        title={t("projects.notes")}
        description={t("projects.notes_hint")}
        action={
          <Button size="sm" variant="ghost" onClick={() => setNoteOpen(true)}>
            <Plus className="size-4" />
            {t("projects.add_note")}
          </Button>
        }
      />
      {hasNotes && notes.isPending ? (
        <Notice>{t("projects.loading")}</Notice>
      ) : notes.error ? (
        <Notice error>{t("projects.failed")}</Notice>
      ) : noteEntries.length ? (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {noteEntries.map((entry) => (
            <li key={entry.path}>
              <button
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                onClick={() => props.onOpenFile(entry)}
              >
                <StickyNote className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">
                  {entry.name
                    .replace(/-[a-f0-9]{8}\.md$/, "")
                    .replace(/\.md$/, "")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>{t("projects.no_notes")}</Notice>
      )}
    </section>
  );
  const tabs = [
    { id: "overview", label: t("projects.overview"), icon: LayoutDashboard },
    { id: "files", label: t("projects.files"), icon: FileText },
    { id: "emails", label: t("projects.emails"), icon: Mail, disabled: true },
    { id: "tasks", label: t("projects.tasks"), icon: ListTodo },
    { id: "notes", label: t("projects.notes"), icon: StickyNote },
    { id: "activity", label: t("projects.activity"), icon: Activity },
  ];
  return (
    <div
      className="@container min-h-0 flex-1 overflow-y-auto"
      data-testid="project-home"
    >
      <div className="flex min-h-full flex-col @min-[850px]:h-full @min-[850px]:flex-row @min-[850px]:overflow-hidden">
        <aside
          aria-label={t("projects.metadata")}
          className="w-full shrink-0 border-b border-border @min-[850px]:w-72 @min-[850px]:overflow-y-auto @min-[850px]:border-r @min-[850px]:border-b-0"
        >
          <div className="space-y-4 border-b border-border p-5">
            <div className="flex items-start gap-3">
              <FolderIcon className="mt-1 size-8" />
              <h1 className="min-w-0 flex-1 break-words text-lg font-semibold tracking-tight">
                {props.name}
              </h1>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("projects.refresh")}
                onClick={refresh}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={props.onNewSession}>
                <MessageSquare className="size-4" />
                {t("projects.new_chat")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNoteOpen(true)}
              >
                <StickyNote className="size-4" />
                {t("projects.add_note")}
              </Button>
            </div>
          </div>
          <div className="p-5">
            <SectionHeading
              title={t("projects.metadata")}
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
              <dl className="mt-4 space-y-3">
                {details.data.fields.map((field) => (
                  <div
                    key={field.id}
                    className="grid grid-cols-2 gap-3 text-sm"
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
          <div className="space-y-3 border-t border-border p-5">
            <p className="text-xs font-medium text-muted-foreground">
              {t("projects.location")}
            </p>
            <button
              className="w-full break-all text-left text-xs leading-relaxed hover:underline"
              onClick={props.onFiles}
            >
              {props.folder}
            </button>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={props.onFiles}
            >
              <FileText className="size-4" />
              {t("projects.all_files")}
            </Button>
          </div>
          <div className="space-y-1 border-t border-border p-3">
            <Button
              className="w-full justify-start"
              variant="ghost"
              onClick={() => setTab("agents")}
            >
              <MessageSquare className="size-4" />
              {t("projects.agents")}
            </Button>
            <span className="block" title={t("projects.tab_review_pending")}>
              <Button className="w-full justify-start" variant="ghost" disabled>
                <Table2 className="size-4" />
                {t("projects.tab_review")}
              </Button>
            </span>
          </div>
        </aside>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setTab(value);
              if (value === "overview") setDirectory("");
            }
          }}
          className="min-h-0 min-w-0 flex-1 gap-0"
        >
          <div className="shrink-0 overflow-x-auto border-b border-border px-4">
            <TabsList
              variant="line"
              aria-label={t("projects.navigation")}
              className="h-13 gap-2 py-2"
            >
              {tabs.map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  disabled={item.disabled}
                  title={
                    item.disabled ? t("projects.emails_pending") : undefined
                  }
                >
                  <item.icon className="size-4" />
                  {item.label}
                </TabsTrigger>
              ))}
              <TabsTrigger
                value="agents"
                className={tab === "agents" ? "" : "hidden"}
              >
                {t("projects.agents")}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="overview"
            className="min-h-0 overflow-y-auto p-6 @min-[1100px]:p-8"
          >
            <div className="mx-auto max-w-5xl space-y-8">
              <section>
                <SectionHeading title={t("projects.highlights")} />
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      label: t("projects.open_tasks"),
                      value: `${taskRows.filter((task) => task.status !== "done" && task.status !== "cancelled").length}${tasks.hasNextPage ? "+" : ""}`,
                      icon: ListTodo,
                      target: "tasks",
                    },
                    {
                      label: t("projects.documents"),
                      value: `${rootFiles.data?.entries.filter((entry) => entry.kind === "file" && !entry.name.startsWith(".")).length ?? 0}${rootFiles.data?.truncated ? "+" : ""}`,
                      icon: FileText,
                      target: "files",
                    },
                    {
                      label: t("projects.sessions"),
                      value: String(sessions.length),
                      icon: MessageSquare,
                      target: "agents",
                    },
                  ].map((item) => (
                    <Surface
                      key={item.target}
                      className="overflow-hidden rounded-xl"
                    >
                      <button
                        className="w-full space-y-4 p-4 text-left hover:bg-muted/30"
                        onClick={() => setTab(item.target)}
                      >
                        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          {item.label}
                          <item.icon className="size-4" />
                        </span>
                        <span className="block text-xl font-medium">
                          {item.value}
                        </span>
                      </button>
                    </Surface>
                  ))}
                </div>
              </section>
              {activitySection}
              {notesSection}
              {taskSection}
              {fileSection}
              {sessionSection}
            </div>
          </TabsContent>
          <TabsContent value="files" className="min-h-0 overflow-y-auto p-6">
            {fileSection}
          </TabsContent>
          <TabsContent value="tasks" className="min-h-0 overflow-y-auto p-6">
            {taskSection}
          </TabsContent>
          <TabsContent value="notes" className="min-h-0 overflow-y-auto p-6">
            {notesSection}
          </TabsContent>
          <TabsContent value="activity" className="min-h-0 overflow-y-auto p-6">
            {activitySection}
          </TabsContent>
          <TabsContent value="agents" className="min-h-0 overflow-y-auto p-6">
            {sessionSection}
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
                const data = await client.updateProjectDetails(workspaceId, {
                  revision: details.data!.revision,
                  fields,
                });
                queryClient.setQueryData(["project", workspaceId], data);
                setEditMetadata(false);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      {linkOpen ? (
        <LinkTask
          client={client}
          workspaceId={workspaceId}
          onClose={() => setLinkOpen(false)}
          onLink={async (id) => {
            await client.patchTask(workspaceId, id, { projectId: workspaceId });
            await invalidateTasks();
            setLinkOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Notice(props: { children: React.ReactNode; error?: boolean }) {
  return (
    <p
      role={props.error ? "alert" : undefined}
      className={`py-5 text-sm ${props.error ? "text-destructive" : "text-muted-foreground"}`}
    >
      {props.children}
    </p>
  );
}

function LinkTask(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  onClose: () => void;
  onLink: (id: string) => Promise<void>;
}) {
  const tasks = useTasks(props, { sort: "updated" });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows =
    tasks.data?.pages
      .flatMap((page) => page.tasks)
      .filter(
        (task) =>
          !task.projectId &&
          task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ) ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projects.link_task")}</DialogTitle>
          <DialogDescription>{t("projects.link_task_hint")}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t("projects.filter_tasks")}
          placeholder={t("projects.filter_tasks")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="max-h-72 overflow-auto">
          {rows.map((task) => (
            <Button
              key={task.id}
              variant="ghost"
              className="h-auto w-full justify-start whitespace-normal text-left"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await props.onLink(task.id);
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : t("projects.failed"),
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {task.title}
            </Button>
          ))}
          {tasks.isPending ? (
            <Notice>{t("projects.loading")}</Notice>
          ) : !rows.length ? (
            <Notice>{t("projects.no_unlinked_tasks")}</Notice>
          ) : null}
          {tasks.hasNextPage ? (
            <Button
              variant="outline"
              disabled={tasks.isFetchingNextPage}
              onClick={() => void tasks.fetchNextPage()}
            >
              {t("projects.more")}
            </Button>
          ) : null}
        </div>
        {error || tasks.error ? (
          <Notice error>{error || t("projects.failed")}</Notice>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
