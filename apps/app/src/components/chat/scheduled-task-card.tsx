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

export function isScheduledTaskTool(part: ToolUIPart | DynamicToolUIPart) {
  return ["legalwork_schedule_create", "legalwork_schedule_update"].includes(getToolName(part));
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
  const navigate = useNavigate();
  const available = Boolean(legalworkClient && initial && initial.workspaceId === workspaceId);
  const query = useQuery({ queryKey: ["scheduled-task", legalworkClient?.baseUrl, workspaceId, initial?.id], enabled: available,
    queryFn: () => legalworkClient!.scheduledTask(workspaceId, initial!.id), refetchInterval: 15000 });
  if (part.state !== "output-available" && part.state !== "output-error") return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("scheduled.loading")}</p>;
  if (!initial) return <p role="alert" className="text-sm text-destructive">{t("scheduled.save_failed")}</p>;
  const task = query.data?.task ?? initial;
  return <Surface className="my-3 flex min-w-0 items-center gap-4 p-4"><IconTile variant="inset"><Clock3 /></IconTile><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{task.title}</p><p className="mt-1 text-xs text-muted-foreground">{query.isError ? t("scheduled.load_failed") : `${scheduleLabel(task.schedule)} · ${taskStatusLabel(task.status)} · ${t(task.projectAccess === "all" ? "scheduled.access_all" : "scheduled.access_project")}`}</p></div><Button variant="outline" size="sm" disabled={!query.data || query.isError} onClick={() => navigate(`/scheduled?task=${encodeURIComponent(task.id)}`)}>{t("scheduled.open")}</Button></Surface>;
}
