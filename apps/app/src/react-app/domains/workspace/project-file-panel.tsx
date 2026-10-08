import { workspaceViewRoute } from "../../shell/workspace-routes";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, FolderOpen } from "lucide-react";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useProjectFiles } from "./project-file-context";
import { ArtifactOriginContext } from "../session/artifacts/artifact-frame";
import { ArtifactPanel } from "../session/artifacts/artifact-panel";
import { PreviewError, PreviewLoading } from "../session/artifacts/preview";
import type { ArtifactPanelTab } from "../session/panel/panel-tab-store";

export function ProjectFilePanel({ source, tab, sessionId, onClose }: { source: ProjectFileSource; tab: ArtifactPanelTab; sessionId: string; onClose: () => void }) {
  const files = useProjectFiles();
  const navigate = useNavigate();
  const foreign = sessionId !== `workspace:${source.projectId}`;
  const [editing, setEditing] = useState(!foreign);
  const project = files?.projects.find(project => project.projectId === source.projectId);
  const resolved = useQuery({
    queryKey: ["project-file-source", project?.baseUrl, project?.workspaceId, source.projectId, source.workspaceId, source.connectionId, source.path],
    queryFn: async () => {
      if (!files) throw new Error(t("project_files.source_unavailable"));
      const owner = files.sourceProject(source);
      if (!source.connectionId) {
        const stat = await owner.client.statWorkspaceFile(owner.workspaceId, source.path);
        if (!stat.exists || stat.kind !== "file") throw new Error(t("project_files.source_unavailable"));
        return { storage: undefined };
      }
      const root = (await owner.client.storageRoots(owner.workspaceId)).roots.find(root => root.id === source.connectionId);
      if (!root) throw new Error(t("project_files.source_unavailable"));
      return { storage: { workspaceId: owner.workspaceId, root, file: { name: source.name, path: source.path, kind: "file", size: null, modifiedAt: null } } satisfies NonNullable<ArtifactPanelTab["storage"]> };
    }, retry: false,
  });
  // Resolve the client from current connections, never from cached query credentials.
  const owner = resolved.data && project?.workspaceId === source.workspaceId ? project : undefined;
  const storage = resolved.data?.storage;
  const projectName = project?.name ?? source.projectId;
  const banner = foreign ? <div data-project-file-origin={source.projectId} className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-primary/20 bg-primary/5 px-3 py-2 text-xs">
      <FolderOpen className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1" title={source.path}>{t("project_files.origin", { project: projectName })} · {t(editing ? "project_files.editing_original" : "project_files.viewing_original")}</span>
      {!editing && <Button variant="outline" size="sm" disabled={!owner} onClick={() => setEditing(true)}>{t("project_files.edit_original")}</Button>}
      {project && <Button variant="ghost" size="icon-sm" aria-label={t("project_files.open_source", { project: projectName })} title={t("project_files.open_source", { project: projectName })} onClick={() => navigate(workspaceViewRoute(source.projectId, "files"))}><ArrowUpRight className="size-4" /></Button>}
    </div> : null;
  return <ArtifactOriginContext value={banner}><div className="flex h-full min-h-0 flex-col">
    {(!owner || resolved.isError) && banner}
    {resolved.isError ? <PreviewError message={resolved.error.message} /> : owner ? <ArtifactPanel sessionId={sessionId} tab={{ ...tab, sourceProject: undefined, value: storage ? undefined : source.path, storage }} client={owner.client} workspaceId={owner.workspaceId} workspaceRoot={owner.root} isRemoteWorkspace={owner.isRemote} localReadOnly={!editing} onClose={onClose} /> : <PreviewLoading />}
  </div></ArtifactOriginContext>;
}
