import { createContext, use, useMemo, useState, type ReactNode } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { WorkspaceSessionGroup } from "@/app/types";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { ProjectPersonalisationSection } from "../settings/pages/project-personalisation-section";
import { workspaceLabel } from "../session/sidebar/utils";

const ProjectPersonalisationContext = createContext<((projectId: string) => void) | null>(null);

export function useProjectPersonalisation() {
  const open = use(ProjectPersonalisationContext);
  if (!open) throw new Error("Project personalization must be used within ProjectPersonalisationProvider");
  return open;
}

export function ProjectPersonalisationProvider(props: {
  children: ReactNode;
  groups: WorkspaceSessionGroup[];
  client: LegalworkServerClient | null;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const workspace = props.groups.find((group) => group.workspace.id === projectId)?.workspace;
  const endpoint = useMemo(() => resolveWorkspaceEndpoint(workspace, {
    baseUrl: props.client?.baseUrl, token: props.client?.token,
  }), [workspace?.id, workspace?.workspaceType, workspace?.baseUrl, workspace?.legalworkHostUrl,
    workspace?.legalworkToken, workspace?.legalworkClientToken, workspace?.legalworkHostToken,
    workspace?.legalworkWorkspaceId, props.client?.baseUrl, props.client?.token]);

  return <ProjectPersonalisationContext.Provider value={setProjectId}>
    {props.children}
    {workspace ? <Dialog open onOpenChange={(open) => { if (!open) setProjectId(null); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("personalisation.project_prompt_menu")}</DialogTitle>
          <DialogDescription>{workspaceLabel(workspace)}</DialogDescription>
        </DialogHeader>
        <ProjectPersonalisationSection
          key={workspace.id}
          client={endpoint?.client ?? null}
          workspaceId={endpoint?.workspaceId ?? workspace.id}
          projectName={workspaceLabel(workspace)}
          active
        />
      </DialogContent>
    </Dialog> : null}
  </ProjectPersonalisationContext.Provider>;
}
