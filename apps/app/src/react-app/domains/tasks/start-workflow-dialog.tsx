/** @jsxImportSource react */
/**
 * Picker for working on a task locally: which folder to work in and, when
 * starting a workflow, which one.
 *
 * `mode: "workflow"` runs a workflow from the user's library; `mode: "session"`
 * opens a plain session that only carries the task's context.
 *
 * The folder picker is the New Chat dropdown from the sidebar — same folder
 * icon, same label resolution, same order — because it is already exactly this
 * choice. The folder decides where the run happens, not which workflows exist:
 * the list is the Workflows pane's own (extensions-store refreshSkills), and on
 * the desktop skills are global, the same set in every folder. Only a remote
 * folder lists from its own server, because that is where it would run.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Inbox, Loader2, Play, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listLocalSkills } from "@/app/lib/desktop";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { isDesktopRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { WorkspaceIcon } from "@/react-app/design-system/workspace-icon";
import {
  isWorkflowCard,
  workflowDisplayName,
} from "@/react-app/domains/settings/pages/skills-view";
import { workspaceLabel } from "@/react-app/domains/session/sidebar/utils";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";

export type StartTaskMode = "workflow" | "session";

/** `workflowName` is null for a plain session. */
export type StartWorkflowSelection = { workspace: RouteWorkspace; workflowName: string | null };

export type StartWorkflowDialogProps = {
  /** Null keeps the dialog closed. */
  mode: StartTaskMode | null;
  taskTitle: string;
  onClose: () => void;
  workspaces: RouteWorkspace[];
  /** Folder pre-selected when the dialog opens (the one the app is already on). */
  defaultWorkspaceId: string;
  linkedProjectId?: string;
  baseUrl: string;
  token: string;
  busy: boolean;
  onStart: (selection: StartWorkflowSelection) => void;
};

type WorkflowOption = { value: string; label: string };

function toWorkflowOptions(entries: ReadonlyArray<{ name: string; kind?: string }>): WorkflowOption[] {
  return entries
    .filter(isWorkflowCard)
    .map((entry) => ({ value: entry.name, label: workflowDisplayName(entry.name) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function StartWorkflowDialog(props: StartWorkflowDialogProps) {
  const open = props.mode !== null;
  const withWorkflow = props.mode === "workflow";
  const folderId = useId();
  const workflowId = useId();
  const [workspaceId, setWorkspaceId] = useState(props.defaultWorkspaceId);
  const [workflowName, setWorkflowName] = useState("");

  useEffect(() => {
    if (open) setWorkspaceId(props.defaultWorkspaceId);
  }, [open, props.defaultWorkspaceId]);

  const workspace = useMemo(
    () => props.linkedProjectId
      ? props.workspaces.find((entry) => entry.id === props.linkedProjectId) ?? null
      : props.workspaces.find((entry) => entry.id === workspaceId) ?? props.workspaces[0] ?? null,
    [props.workspaces, workspaceId, props.linkedProjectId],
  );
  const globalLibrary = isDesktopRuntime() && workspace?.workspaceType !== "remote";

  const endpoint = useMemo(
    () =>
      workspace && !globalLibrary
        ? resolveWorkspaceEndpoint(workspace, { baseUrl: props.baseUrl, token: props.token })
        : null,
    [globalLibrary, props.baseUrl, props.token, workspace],
  );

  const workflowsQuery = useQuery({
    queryKey: ["intake-workflow-library", globalLibrary ? "global" : (endpoint?.workspaceId ?? "")],
    enabled: withWorkflow && (globalLibrary || Boolean(endpoint)),
    queryFn: async (): Promise<WorkflowOption[]> => {
      if (globalLibrary) {
        const { items: local } = await listLocalSkills("");
        return toWorkflowOptions(
          local.map((entry) => ({ name: entry.name, kind: (entry as { kind?: string }).kind })),
        );
      }
      if (!endpoint) return [];
      const response = await endpoint.client.listSkills(endpoint.workspaceId, { includeGlobal: true });
      return toWorkflowOptions(response.items);
    },
  });

  const workflows = useMemo(() => workflowsQuery.data ?? [], [workflowsQuery.data]);

  // Keep the selection valid as the library loads or changes.
  useEffect(() => {
    if (!workflows.length) {
      setWorkflowName("");
      return;
    }
    setWorkflowName((current) =>
      workflows.some((item) => item.value === current) ? current : workflows[0].value,
    );
  }, [workflows]);

  const canStart = Boolean(workspace && (!withWorkflow || workflowName)) && !props.busy;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-md flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pr-12">
          <DialogTitle>{t(withWorkflow ? "tasks.start_workflow" : "tasks.start_session")}</DialogTitle>
          <DialogDescription>
            {t(props.linkedProjectId ? "tasks.linked_workflow_desc" : withWorkflow ? "tasks.start_workflow_desc" : "tasks.start_session_desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto p-6">
          <div className="flex items-start gap-2 border-b border-border pb-4 text-sm text-muted-foreground">
            <Inbox aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p className="line-clamp-2 [overflow-wrap:anywhere]" title={props.taskTitle}>{props.taskTitle}</p>
          </div>

          <div className="flex flex-col gap-5">
            {props.linkedProjectId ? <p className="flex items-center gap-2 text-sm text-muted-foreground">{workspace ? <><WorkspaceIcon workspaceId={workspace.id} sizeClass="size-4" />{workspaceLabel(workspace)}</> : t("tasks.linked_project_unavailable")}</p> : <div className="flex flex-col gap-1.5">
              <Label htmlFor={folderId} className="text-xs">
                {t("tasks.run_folder_label")}
              </Label>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button id={folderId} variant="outline" disabled={props.busy || props.workspaces.length === 0} className="h-9 w-full justify-between gap-2 rounded-lg px-3 font-normal">
                      <span className="flex min-w-0 items-center gap-2">
                        {workspace ? (
                          <>
                            <WorkspaceIcon workspaceId={workspace.id} sizeClass="size-4" />
                            <span className="truncate">{workspaceLabel(workspace)}</span>
                          </>
                        ) : (
                          <span className="truncate text-muted-foreground">{t("tasks.run_no_folders")}</span>
                        )}
                      </span>
                      <ChevronDown className="text-muted-foreground" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-(--anchor-width)">
                  {props.workspaces.map((entry) => (
                    <DropdownMenuItem key={entry.id} onClick={() => setWorkspaceId(entry.id)}>
                      <WorkspaceIcon workspaceId={entry.id} sizeClass="size-4" />
                      <span className="truncate">{workspaceLabel(entry)}</span>
                      {entry.id === workspace?.id ? <Check className="ms-auto text-muted-foreground" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("tasks.run_folder_hint")}</p>
            </div>}

            {withWorkflow ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={workflowId} className="text-xs">
                  {t("tasks.run_workflow_label")}
                </Label>
                {workflowsQuery.isLoading ? (
                  <Skeleton
                    role="status"
                    aria-label={t("tasks.run_workflows_loading")}
                    className="h-9 w-full rounded-lg"
                  />
                ) : workflowsQuery.isError ? (
                  <div role="alert" className="space-y-3 rounded-lg bg-muted/40 p-3">
                    <p className="flex items-start gap-2 text-sm text-muted-foreground">
                      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                      {t("tasks.run_workflows_failed")}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => void workflowsQuery.refetch()} disabled={workflowsQuery.isFetching}>
                      <RefreshCw className={workflowsQuery.isFetching ? "animate-spin" : undefined} />
                      {t("tasks.retry")}
                    </Button>
                  </div>
                ) : workflows.length ? (
                  <Select
                    value={workflowName}
                    disabled={props.busy}
                    items={workflows}
                    onValueChange={(value) => setWorkflowName(value ?? "")}
                  >
                    <SelectTrigger
                      id={workflowId}
                      className="h-9 w-full rounded-lg bg-background"
                      aria-label={t("tasks.run_workflow_label")}
                    >
                      <SelectValue className="min-w-0 truncate" placeholder={t("tasks.run_workflow_label")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {workflows.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="rounded-lg bg-muted/40 px-3 py-3 text-sm leading-relaxed text-muted-foreground">
                    {t("tasks.run_no_workflows")}
                  </p>
                )}
              </div>
            ) : null}
          </div>

        </div>
        <DialogFooter className="mx-0 mb-0 shrink-0">
          <Button variant="ghost" onClick={props.onClose} disabled={props.busy}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!canStart}
            aria-busy={props.busy}
            onClick={() => {
              if (!workspace) return;
              if (withWorkflow && !workflowName) return;
              props.onStart({ workspace, workflowName: withWorkflow ? workflowName : null });
            }}
          >
            {props.busy ? <Loader2 className="animate-spin" /> : <Play />}
            {t("tasks.run_start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
