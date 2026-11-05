import { useMetadataPolling } from "@/react-app/infra/metadata-polling";
import { useNavigate } from "react-router-dom";
import { getToolName, type ToolUIPart, type DynamicToolUIPart } from "ai";
import { useQuery } from "@tanstack/react-query";
import { Clock3, Loader2 } from "lucide-react";
import { ScheduledTaskSchema } from "@legalwork/types/scheduled-tasks";
import { Button } from "@/components/ui/button";
import { IconTile, Surface } from "@/react-app/design-system/surface";
import { scheduleLabel, taskStatusLabel } from "@/react-app/domains/scheduled-tasks/schedule-format";
import { t } from "@/i18n";
import { useMessageList } from "./message-list-provider";
import type { parseScheduledRunMessage } from "@/react-app/domains/scheduled-tasks/scheduled-message";

function ScheduledTaskCard({ title, detail, prompt, taskId, canOpen }: {
  title: string; detail: string; prompt?: string; taskId?: string; canOpen: boolean;
}) {
  const navigate = useNavigate();
  return <Surface className="my-3 min-w-0 overflow-hidden">
    <div className="flex items-center gap-4 p-4"><IconTile variant="inset"><Clock3 /></IconTile>
      <div className="min-w-0 flex-1">{prompt !== undefined && <p className="mb-1 text-xs text-muted-foreground">{t("scheduled.task")}</p>}
        <p className="truncate text-sm font-medium">{title}</p>{detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
      </div>
      {taskId && <Button variant="outline" size="sm" disabled={!canOpen} onClick={() => navigate(`/scheduled?task=${encodeURIComponent(taskId)}`)}>{t("scheduled.open")}</Button>}
    </div>
    {prompt !== undefined && <div className="whitespace-pre-wrap break-words border-t border-border px-4 py-3 text-sm leading-relaxed">{prompt}</div>}
  </Surface>;
}

export function isScheduledTaskTool(part: ToolUIPart | DynamicToolUIPart) {
  return ["legalwork_schedule_create", "legalwork_schedule_update"].includes(getToolName(part))
    || getToolName(part) === "legalwork_assistant_briefing" && Boolean(part.input && typeof part.input === "object" && "action" in part.input && part.input.action === "create");
}
export function parseScheduledTaskCard(output: unknown) {
  try {
    const value: unknown = typeof output === "string" ? JSON.parse(output) : output;
    const payload = value && typeof value === "object" && "referenceData" in value ? value.referenceData : value;
    const result = ScheduledTaskSchema.safeParse(payload && typeof payload === "object" && "task" in payload ? payload.task : null);
    return result.success ? result.data : null;
  } catch { return null; }
}
export function ScheduledTaskToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const initial = part.state === "output-available" ? parseScheduledTaskCard(part.output) : null;
  const { legalworkClient, workspaceId } = useMessageList();
  const metadataInterval = useMetadataPolling(legalworkClient?.baseUrl, 15000);
  const available = Boolean(legalworkClient && initial && initial.workspaceId === workspaceId);
  const query = useQuery({ queryKey: ["scheduled-task", legalworkClient?.baseUrl, workspaceId, initial?.id], enabled: available,
    queryFn: () => legalworkClient!.scheduledTask(workspaceId, initial!.id), refetchInterval: metadataInterval });
  if (part.state !== "output-available" && part.state !== "output-error") return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("scheduled.loading")}</p>;
  if (!initial) return <p role="alert" className="text-sm text-destructive">{t("scheduled.save_failed")}</p>;
  const task = query.data?.task ?? initial;
  return <ScheduledTaskCard title={task.title} taskId={task.id} canOpen={available && Boolean(query.data) && !query.isError}
    detail={query.isError ? t("scheduled.load_failed") : `${scheduleLabel(task.schedule)} · ${taskStatusLabel(task.status)} · ${t(task.projectAccess === "all" ? "scheduled.access_all" : "scheduled.access_project")}`} />;
}

export function ScheduledTaskRunCard({ run }: { run: NonNullable<ReturnType<typeof parseScheduledRunMessage>> }) {
  const { legalworkClient, workspaceId, sessionId } = useMessageList();
  const available = Boolean(legalworkClient && (!run.workspaceId || run.workspaceId === workspaceId));
  const list = useQuery({ queryKey: ["scheduled-tasks", legalworkClient?.baseUrl], enabled: available && !run.taskId,
    queryFn: () => legalworkClient!.scheduledTasks(), staleTime: 15000 });
  const matches = list.data?.tasks.filter(task => task.workspaceId === workspaceId && task.title === run.title && task.prompt === run.prompt) ?? [];
  const taskId = run.taskId ?? (matches.length === 1 ? matches[0].id : undefined);
  const metadataInterval = useMetadataPolling(legalworkClient?.baseUrl, 15000);
  const query = useQuery({ queryKey: ["scheduled-task", legalworkClient?.baseUrl, workspaceId, taskId], enabled: available && Boolean(taskId),
    queryFn: () => legalworkClient!.scheduledTask(workspaceId, taskId!), refetchInterval: metadataInterval });
  // Legacy text alone must not link an unrelated task with the same name.
  const linked = available && query.data && (run.taskId || query.data.runs.some(item => item.sessionId === sessionId));
  const task = linked ? query.data?.task : undefined;
  return <ScheduledTaskCard title={run.title} prompt={run.prompt} taskId={task?.id} canOpen={Boolean(task) && !query.isError}
    detail={task ? `${scheduleLabel(task.schedule)} · ${taskStatusLabel(task.status)}` : ""} />;
}
