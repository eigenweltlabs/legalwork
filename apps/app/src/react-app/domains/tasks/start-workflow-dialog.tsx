/** @jsxImportSource react */
/**
 * "Start workflow" picker: which workflow from the user's own library, and
 * which folder to run it in.
 *
 * The folder picker is the New Chat dropdown from the sidebar — same folder
 * icon, same label resolution, same order — because it is already exactly this
 * choice. Workflows are listed per folder (`includeGlobal`), so switching the
 * folder re-reads the library the run would actually see.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

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
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { t } from "@/i18n";
import { WorkspaceIcon } from "@/react-app/design-system/workspace-icon";
import { workspaceLabel } from "@/react-app/domains/session/sidebar/utils";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";

export type StartWorkflowSelection = { workspace: RouteWorkspace; workflowName: string };

export type StartWorkflowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: RouteWorkspace[];
  /** Folder pre-selected when the dialog opens (the one the app is already on). */
  defaultWorkspaceId: string;
  baseUrl: string;
  token: string;
  busy: boolean;
  onStart: (selection: StartWorkflowSelection) => void;
};

export function StartWorkflowDialog(props: StartWorkflowDialogProps) {
  const [workspaceId, setWorkspaceId] = useState(props.defaultWorkspaceId);
  const [workflowName, setWorkflowName] = useState("");

  useEffect(() => {
    if (props.open) setWorkspaceId(props.defaultWorkspaceId);
  }, [props.open, props.defaultWorkspaceId]);

  const workspace = useMemo(
    () => props.workspaces.find((entry) => entry.id === workspaceId) ?? props.workspaces[0] ?? null,
    [props.workspaces, workspaceId],
  );

  const endpoint = useMemo(
    () => (workspace ? resolveWorkspaceEndpoint(workspace, { baseUrl: props.baseUrl, token: props.token }) : null),
    [props.baseUrl, props.token, workspace],
  );

  const workflowsQuery = useQuery({
    queryKey: ["intake-workflow-library", endpoint?.baseUrl ?? "", endpoint?.workspaceId ?? ""],
    enabled: props.open && Boolean(endpoint),
    queryFn: async () => {
      if (!endpoint) return [];
      const response = await endpoint.client.listSkills(endpoint.workspaceId, { includeGlobal: true });
      return response.items.filter((item) => item.kind === "workflow");
    },
  });

  const workflows = workflowsQuery.data ?? [];

  // Keep the selection valid as the folder (and therefore the library) changes.
  useEffect(() => {
    if (!workflows.length) {
      setWorkflowName("");
      return;
    }
    setWorkflowName((current) =>
      workflows.some((item) => item.name === current) ? current : workflows[0].name,
    );
  }, [workflows]);

  const canStart = Boolean(workspace && workflowName) && !props.busy;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tasks.start_workflow")}</DialogTitle>
          <DialogDescription>{t("tasks.start_workflow_desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t("tasks.run_folder_label")}</Label>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" className="w-full justify-start gap-2 font-normal">
                    {workspace ? (
                      <>
                        <WorkspaceIcon workspaceId={workspace.id} sizeClass="size-4" />
                        <span className="truncate">{workspaceLabel(workspace)}</span>
                      </>
                    ) : (
                      <span className="truncate text-muted-foreground">{t("tasks.run_no_folders")}</span>
                    )}
                  </Button>
                }
              />
              <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-72">
                {props.workspaces.map((entry) => (
                  <DropdownMenuItem key={entry.id} onClick={() => setWorkspaceId(entry.id)}>
                    <WorkspaceIcon workspaceId={entry.id} sizeClass="size-4" />
                    <span className="truncate">{workspaceLabel(entry)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t("tasks.run_workflow_label")}</Label>
            {workflowsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("tasks.run_workflows_loading")}</p>
            ) : workflows.length ? (
              <Select value={workflowName} onValueChange={(value) => setWorkflowName(value ?? "")}>
                <SelectTrigger className="w-full" aria-label={t("tasks.run_workflow_label")}>
                  <SelectValue placeholder={t("tasks.run_workflow_label")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {workflows.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">{t("tasks.run_no_workflows")}</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={props.busy}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!canStart}
            onClick={() => {
              if (!workspace || !workflowName) return;
              props.onStart({ workspace, workflowName });
            }}
          >
            {props.busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("tasks.run_start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
