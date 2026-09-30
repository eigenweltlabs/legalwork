import { useState } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { StatusGlyph } from "./task-glyphs";
import { useTasks, useUpdateTask } from "./tasks-queries";
import { t } from "@/i18n";

export function LinkProjectTaskDialog(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  projectId: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const tasks = useTasks(props, { sort: "updated" });
  const update = useUpdateTask(props);
  const rows = (tasks.data?.pages.flatMap((page) => page.tasks) ?? []).filter(
    (task) =>
      !task.projectId &&
      task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !update.isPending) props.onClose();
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
              className="h-auto w-full justify-start gap-2 py-3 text-left font-normal"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { taskId: task.id, patch: { projectId: props.projectId } },
                  {
                    onSuccess: props.onClose,
                    onError: () => toast.error(t("tasks.update_failed")),
                  },
                )
              }
            >
              <StatusGlyph status={task.status} />
              <span className="truncate">{task.title}</span>
            </Button>
          ))}
          {tasks.isPending || !rows.length ? (
            <p className="py-5 text-center text-sm text-muted-foreground">
              {t(
                tasks.isPending
                  ? "projects.loading"
                  : "projects.no_unlinked_tasks",
              )}
            </p>
          ) : null}
          {tasks.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              disabled={tasks.isFetchingNextPage}
              onClick={() => void tasks.fetchNextPage()}
            >
              {t("tasks.load_more")}
            </Button>
          ) : null}
          {tasks.error ? (
            <p role="alert" className="py-3 text-sm text-destructive">
              {t("tasks.load_failed")}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
