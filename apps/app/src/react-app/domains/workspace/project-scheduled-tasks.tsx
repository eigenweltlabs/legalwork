import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronRight } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useMetadataPolling } from "@/react-app/infra/metadata-polling";
import { formatRunTime, scheduleLabel, taskStatusLabel } from "../scheduled-tasks/schedule-format";

export function ProjectScheduledTasks({ client, workspaceId, active }: {
  client: LegalworkServerClient;
  workspaceId: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const refetchInterval = useMetadataPolling(client.baseUrl, 15_000);
  const schedules = useQuery({
    queryKey: ["scheduled-tasks", client.baseUrl],
    queryFn: () => client.scheduledTasks(),
    select: data => data.tasks.filter(task => task.workspaceId === workspaceId),
    enabled: active,
    refetchInterval,
  });

  return <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border/60 bg-background/60 px-5 py-1.5 @min-[720px]/project-page:px-6">
    <CollapsibleTrigger render={<Button variant="ghost" className="w-full justify-start gap-2 px-0 text-sm font-normal hover:bg-transparent aria-expanded:bg-transparent" />}>
      <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      {t("projects.scheduled_tasks")}
      {schedules.data && <span className="text-xs tabular-nums text-muted-foreground">{schedules.data.length}</span>}
    </CollapsibleTrigger>
    <CollapsibleContent className="pb-3 pt-2">
      {schedules.isPending && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{t("scheduled.loading")}</p>}
      {schedules.isError && <div role="alert" className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
        {t("scheduled.load_failed")} <Button variant="ghost" size="sm" onClick={() => void schedules.refetch()}>{t("scheduled.retry")}</Button>
      </div>}
      {schedules.isSuccess && schedules.data.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{t("projects.no_scheduled_tasks")}</p>}
      {schedules.data && schedules.data.length > 0 && <ul className="-mx-2">
        {schedules.data.map(task => <li key={task.id}>
          <Button variant="ghost" nativeButton={false} role="link"
            render={<Link to={`/scheduled?task=${encodeURIComponent(task.id)}`} />}
            className="grid h-auto min-h-9 w-full min-w-0 justify-start gap-x-10 gap-y-0.5 rounded-lg px-2 py-1.5 text-left text-xs font-normal whitespace-normal @min-[640px]/project-page:grid-cols-2">
            <span className="flex min-w-0 items-center gap-2 text-foreground">
              <CalendarClock aria-hidden className="size-3.5 text-muted-foreground opacity-70" />
              <span className="min-w-0 break-words">{task.title}</span>
            </span>
            <span className="min-w-0 pl-5.5 text-muted-foreground @min-[640px]/project-page:pl-0">
              {scheduleLabel(task.schedule)} <span aria-hidden>·</span>{" "}
              {task.status === "active" && task.nextRunAt ? <>{t("scheduled.next_run")} <time dateTime={task.nextRunAt}>{formatRunTime(task.nextRunAt, task.schedule.timeZone)}</time></> : taskStatusLabel(task.status)}
            </span>
          </Button>
        </li>)}
      </ul>}
    </CollapsibleContent>
  </Collapsible>;
}
