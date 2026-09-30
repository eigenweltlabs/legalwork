import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { WorkspaceSessionGroup } from "@/app/types";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { ProjectNoteDialog } from "./project-note-dialog";
import { ProjectTaskDialog } from "./project-task-dialog";
import { ProjectSettingsPanel, type ProjectSettingsSection } from "./project-settings-panel";

type CreateAction = "chat" | "note" | "task" | "record" | "group";
type Props = {
  children: ReactNode;
  groups: WorkspaceSessionGroup[];
  client: LegalworkServerClient | null;
  newChatDisabled: boolean;
  onNewChat: (projectId: string) => void;
  onRecord: (projectId: string) => void;
  onCreateGroup: (projectId: string) => void;
  onRename: (projectId: string, name: string) => Promise<boolean>;
  onReveal: (projectId: string) => void;
  onForget: (projectId: string) => void;
};
type ProjectControls = {
  openSettings: (workspace: WorkspaceInfo, section?: ProjectSettingsSection) => void;
  create: (workspace: WorkspaceInfo, action: CreateAction) => void;
  onReveal: Props["onReveal"];
  onForget: Props["onForget"];
  newChatDisabled: boolean;
};
const ProjectControlsContext = createContext<ProjectControls | null>(null);

export function useProjectControls() {
  const controls = use(ProjectControlsContext);
  if (!controls) throw new Error("Project controls must be used within ProjectControlsProvider");
  return controls;
}

export function ProjectControlsProvider(props: Props) {
  const [settings, setSettings] = useState<{ projectId: string; section: ProjectSettingsSection } | null>(null);
  const [creation, setCreation] = useState<{ projectId: string; kind: "note" | "task" } | null>(null);
  const queryClient = useQueryClient();
  const projectId = settings?.projectId ?? creation?.projectId;
  const workspace = props.groups.find((group) => group.workspace.id === projectId)?.workspace;
  const endpoint = useMemo(() => resolveWorkspaceEndpoint(workspace, {
    baseUrl: props.client?.baseUrl, token: props.client?.token,
  }), [workspace?.id, workspace?.workspaceType, workspace?.baseUrl, workspace?.legalworkHostUrl,
    workspace?.legalworkToken, workspace?.legalworkClientToken, workspace?.legalworkHostToken,
    workspace?.legalworkWorkspaceId, props.client?.baseUrl, props.client?.token]);
  const refreshNotes = () => {
    if (!endpoint) return;
    for (const key of ["project-files", "project-notes", "workspace-files"]) {
      void queryClient.invalidateQueries({ queryKey: [key, endpoint.workspaceId] });
    }
  };
  const controls: ProjectControls = {
    newChatDisabled: props.newChatDisabled,
    onReveal: props.onReveal,
    onForget: props.onForget,
    openSettings: (workspace, section = "general") => {
      setCreation(null);
      setSettings({ projectId: workspace.id, section });
    },
    create: (workspace, action) => {
      if (action === "chat") props.onNewChat(workspace.id);
      else if (action === "record") props.onRecord(workspace.id);
      else if (action === "group") props.onCreateGroup(workspace.id);
      else {
        if (!resolveWorkspaceEndpoint(workspace, { baseUrl: props.client?.baseUrl, token: props.client?.token })) {
          toast.error(t("personalisation.server_required"));
          return;
        }
        setSettings(null);
        setCreation({ projectId: workspace.id, kind: action });
      }
    },
  };
  return <ProjectControlsContext.Provider value={controls}>
    {props.children}
    {settings && workspace ? <ProjectSettingsPanel
      key={workspace.id}
      workspace={workspace}
      client={endpoint?.client ?? null}
      workspaceId={endpoint?.workspaceId ?? workspace.id}
      initialSection={settings.section}
      onClose={() => setSettings(null)}
      onRename={(name) => props.onRename(workspace.id, name)}
      onReveal={() => props.onReveal(workspace.id)}
      onForget={() => { setSettings(null); props.onForget(workspace.id); }}
    /> : null}
    {creation && endpoint && workspace ? creation.kind === "note"
      ? <ProjectNoteDialog key={workspace.id} client={endpoint.client} workspaceId={endpoint.workspaceId} onClose={() => setCreation(null)} onSaved={refreshNotes} />
      : <ProjectTaskDialog key={workspace.id} client={endpoint.client} workspaceId={endpoint.workspaceId} onClose={() => setCreation(null)} />
      : null}
  </ProjectControlsContext.Provider>;
}
