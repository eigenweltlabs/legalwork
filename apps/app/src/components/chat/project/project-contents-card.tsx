import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ProjectContentItem, ProjectContentKind, ProjectContentSection, ProjectContents } from "@legalwork/types/workspace";
import { ArrowLeft, ArrowUpRight, CheckSquare, File, FileAudio, Folder, Loader2, MessageSquare, Paperclip, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useMessageList } from "../message-list-provider";
import { requestOpenTask } from "@/react-app/domains/tasks/task-reference";
import { requestPanelTab } from "@/react-app/domains/session/panel/panel-tab-request";
import { classifyOpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { useRecorderStore } from "@/react-app/domains/recorder/recorder-store";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { projectFieldLabel } from "@/react-app/domains/workspace/project-defaults-store";
import { parseProjectContents } from "./project-tool";

const icons = { tasks: CheckSquare, notes: StickyNote, files: File, recordings: FileAudio, sessions: MessageSquare };
function sectionLabels() {
  return { tasks: t("projects.tasks"), notes: t("projects.notes"), files: t("project_chat.files"), recordings: t("recorder.recordings_title"), sessions: t("projects.sessions") };
}
function taskStatus(status?: string) {
  switch (status) {
    case "open": return t("tasks.status_open");
    case "in_progress": return t("tasks.status_in_progress");
    case "done": return t("tasks.status_done");
    case "cancelled": return t("tasks.status_cancelled");
    default: return null;
  }
}
function duration(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }

export function ProjectContentsTool({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  if (part.state === "output-error") return <p role="alert" className="text-sm text-muted-foreground">{t("project_chat.failed")}</p>;
  if (part.state !== "output-available") return <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("project_chat.loading")}</div>;
  const contents = parseProjectContents(part.output);
  return contents ? <ProjectContentsCard contents={contents} /> : <p role="alert" className="text-sm text-muted-foreground">{t("project_chat.failed")}</p>;
}

export function ProjectContentsCard({ contents }: { contents: ProjectContents }) {
  const { legalworkClient, workspaceId } = useMessageList();
  const navigate = useNavigate();
  const [pages, setPages] = useState<Partial<Record<ProjectContentKind, ProjectContentSection>>>({});
  const [visible, setVisible] = useState<Partial<Record<ProjectContentKind, number>>>({});
  const [pending, setPending] = useState<ProjectContentKind | null>(null);
  const labels = sectionLabels();
  const matchesProject = workspaceId === contents.project.id;
  const fields = contents.project.fields.filter((field) => field.value !== null && field.value !== "");
  const load = async (section: ProjectContentSection, options: { path?: string; more?: boolean } = {}) => {
    if (!legalworkClient || !matchesProject || pending) return;
    setPending(section.kind);
    try {
      const next = await legalworkClient.getProjectContents(workspaceId, {
        kind: section.kind, path: options.path ?? section.path,
        ...(options.more && section.nextCursor ? { cursor: section.nextCursor } : {}),
      });
      const updated = next.sections.find((value) => value.kind === section.kind);
      if (!updated || updated.unavailable) throw new Error("unavailable");
      setVisible((current) => ({ ...current, [section.kind]: options.more ? section.items.length + updated.items.length : 3 }));
      setPages((current) => ({ ...current, [section.kind]: {
        ...updated, items: options.more ? [...section.items, ...updated.items.filter((item) => !section.items.some((old) => old.id === item.id))] : updated.items,
      } }));
    } catch { toast.error(t("project_chat.failed")); }
    finally { setPending(null); }
  };
  const open = async (item: ProjectContentItem, section: ProjectContentSection) => {
    if (!matchesProject) return;
    if (item.kind === "tasks") requestOpenTask(item.id, item.title);
    else if (item.kind === "sessions") navigate(workspaceSessionRoute(workspaceId, item.id));
    else if (item.kind === "recordings") {
      try { await useRecorderStore.getState().openRecording(item.id); }
      catch { toast.error(t("project_chat.failed")); }
    } else if (item.directory) await load(section, { path: item.id });
    else requestPanelTab({ id: `file:${item.id.toLowerCase()}`, type: "artifact", label: item.title, value: item.id, preview: classifyOpenTarget(item.id, "file") });
  };
  return <section aria-label={t("project_chat.title")} className="@container/project-card my-2 overflow-hidden rounded-2xl border border-border bg-background">
    <header className="border-b border-border px-4 py-3">
      <div className="text-xs text-muted-foreground">{t("project_chat.title")}</div>
      <div className="mt-0.5 truncate text-base font-semibold">{contents.project.name}</div>
      {fields.length ? <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{fields.map((field) => <div key={field.id} className="flex min-w-0 gap-1.5"><dt className="text-muted-foreground">{projectFieldLabel(field)}</dt><dd className="max-w-64 truncate">{String(field.value)}</dd></div>)}</dl> : null}
    </header>
    <div className="grid gap-px bg-border @lg/project-card:grid-cols-2">
      {contents.sections.map((original, index) => {
        const section = pages[original.kind] ?? original;
        const Icon = icons[section.kind];
        const shown = visible[section.kind] ?? 3;
        const hasHidden = section.items.length > shown;
        return <section key={section.kind} aria-label={labels[section.kind]} className={`min-w-0 bg-background p-3 ${index === contents.sections.length - 1 && contents.sections.length % 2 ? "@lg/project-card:col-span-2" : ""}`}>
          <div className="mb-2 flex items-center gap-2 px-1 text-sm font-medium"><Icon className="size-4 text-muted-foreground" />{labels[section.kind]}<Badge variant="secondary" className="ml-auto text-xs font-normal">{section.unavailable ? "–" : section.items.length}{section.nextCursor ? "+" : ""}</Badge></div>
          {section.path ? <Button variant="ghost" size="xs" className="mb-1 max-w-full" disabled={pending !== null} onClick={() => void load(section, { path: section.path.split("/").slice(0, -1).join("/") })}><ArrowLeft className="size-3" /><span className="truncate">{section.path.split("/").at(-1)}</span></Button> : null}
          {section.unavailable ? <p className="px-1 py-3 text-xs text-muted-foreground">{t("project_chat.unavailable")}</p>
            : !section.items.length ? <p className="px-1 py-3 text-xs text-muted-foreground">{t("project_chat.empty")}</p>
            : <ul className="space-y-0.5">{section.items.slice(0, shown).map((item) => <li key={item.id}>
              <Button variant="ghost" disabled={!matchesProject || pending !== null} className="group h-auto w-full justify-start gap-2 rounded-lg px-2 py-2 text-left font-normal" onClick={() => void open(item, section)}>
                {item.directory ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.title || t("project_chat.untitled_session")}</span>
                  {item.preview ? <span className="mt-0.5 line-clamp-2 whitespace-normal text-xs leading-4 text-muted-foreground">{item.preview}</span> : null}
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {item.kind === "tasks" ? taskStatus(item.status) : null}
                    {item.durationMs !== undefined ? duration(item.durationMs) : null}
                    {item.attachmentCount ? <span className="inline-flex items-center gap-1"><Paperclip className="size-3" />{item.attachmentCount}</span> : null}
                  </span>
                </span>
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
              </Button>
            </li>)}</ul>}
          {hasHidden || section.nextCursor || section.unavailable ? <Button variant="ghost" size="xs" disabled={pending !== null || (!hasHidden && !legalworkClient) || !matchesProject} className="mt-2 text-muted-foreground" onClick={() => { if (hasHidden) setVisible((current) => ({ ...current, [section.kind]: shown + 5 })); else void load(section, { more: !section.unavailable }); }}>{pending === section.kind ? <Loader2 className="size-3 animate-spin" /> : null}{section.unavailable ? t("project_chat.retry") : t("project_chat.more")}</Button> : null}
        </section>;
      })}
    </div>
  </section>;
}
