import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { NewTaskDialog } from "../tasks/new-task-dialog";
import { requestOpenTask } from "../tasks/task-reference";
import { useCreateTask, useTaskAccess, useTaskMembers, useTaskSyncStatus, useTaskTags } from "../tasks/tasks-queries";

export function ProjectTaskDialog(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  onClose: () => void;
}) {
  const createTask = useCreateTask(props);
  const access = useTaskAccess(props);
  const sync = useTaskSyncStatus(props);
  const members = useTaskMembers(props);
  const tags = useTaskTags(props);

  return <NewTaskDialog
    open
    busy={createTask.isPending}
    connected={Boolean(sync.data?.connected ?? access.connected)}
    members={members.data ?? []}
    tagSuggestions={tags.data ?? []}
    onClose={() => { if (!createTask.isPending) props.onClose(); }}
    onCreate={(input) => createTask.mutate({ ...input, projectId: props.workspaceId }, {
      onSuccess: (task) => {
        props.onClose();
        requestOpenTask(task.id, task.title);
      },
      onError: (error) => toast.error(t("tasks.create_failed"), { description: error instanceof Error ? error.message : undefined }),
    })}
  />;
}
