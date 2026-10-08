import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import type { WorkspaceSessionGroup } from "@/app/types";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { writeProjectFileDrag } from "@/app/lib/project-file-drag";
import { t } from "@/i18n";
import { workspaceLabel } from "../session/sidebar/utils";
import { useComposerStateStore, getComposerDraft, getComposerMentions } from "../session/surface/composer-state-store";
import { encodeComposerMentionValue } from "../session/surface/composer/mention-encoding";
import { createProjectAttachmentMention } from "../session/surface/composer/workspace-attachment";

const ProjectFilesContext = createContext<(ReturnType<typeof createProjectFileAccess> & { dragTypes: readonly string[] }) | null>(null);

export function createProjectFileAccess(groups: WorkspaceSessionGroup[], local: LegalworkServerClient | null, createChat: (projectId: string) => void | string | Promise<string | void>) {
  const projects = groups.flatMap(({ workspace }) => {
    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl: local?.baseUrl, token: local?.token });
    if (!endpoint) return [];
    return [{ ...endpoint, client: !endpoint.isRemote && endpoint.baseUrl === local?.baseUrl ? local : endpoint.client, projectId: workspace.id, name: workspaceLabel(workspace), root: workspace.path }];
  });
  const project = (id: string) => {
    const result = projects.find(item => item.projectId === id);
    if (!result) throw new Error(t("project_files.source_unavailable"));
    return result;
  };
  const sourceProject = (source: ProjectFileSource) => {
    const result = project(source.projectId);
    if (result.workspaceId !== source.workspaceId) throw new Error(t("project_files.source_unavailable"));
    return result;
  };
  const attach = (source: ProjectFileSource, sessionId: string) => {
    const value = createProjectAttachmentMention(source, sourceProject(source).name);
    const state = useComposerStateStore.getState();
    const draft = getComposerDraft(state, sessionId);
    state.setDraft(sessionId, `${draft}${draft && !/\s$/.test(draft) ? " " : ""}@${encodeComposerMentionValue(value)} `);
    state.setMentions(sessionId, { ...getComposerMentions(useComposerStateStore.getState(), sessionId), [value]: "upload" });
  };
  const identify = (client: LegalworkServerClient, workspaceId: string, file: { name: string; path: string; connectionId?: string }): ProjectFileSource | null => {
      const match = projects.find(item => item.client.baseUrl === client.baseUrl && item.client.token === client.token && item.workspaceId === workspaceId);
      return match ? { ...file, projectId: match.projectId, workspaceId } : null;
    };
  return {
    projects, project, sourceProject, attach, identify,
    drag(data: DataTransfer, client: LegalworkServerClient, workspaceId: string, file: { name: string; path: string; connectionId?: string }) {
      const source = identify(client, workspaceId, file);
      if (source) writeProjectFileDrag(data, source);
    },
    async readSaved(source: ProjectFileSource) {
      const owner = sourceProject(source);
      const copy = source.connectionId ? await owner.client.checkoutStorageFile(owner.workspaceId, source.connectionId, source.path) : null;
      const path = copy?.localPath ?? source.path;
      const before = await owner.client.statWorkspaceFile(owner.workspaceId, path);
      if (!before.exists || before.kind !== "file") throw new Error(t("project_files.source_unavailable"));
      const download = await owner.client.downloadWorkspaceFile(owner.workspaceId, path);
      const after = await owner.client.statWorkspaceFile(owner.workspaceId, path);
      if (!after.exists || before.updatedAt !== after.updatedAt || before.size !== after.size) throw new Error(t("project_files.changed_during_copy"));
      const digest = await crypto.subtle.digest("SHA-256", download.data);
      const version = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      return { ...download, version, projectName: owner.name };
    },
    async newChat(projectId: string, source: ProjectFileSource | ProjectFileSource[]) {
      const sources = Array.isArray(source) ? source : [source];
      sources.forEach(sourceProject);
      const id = await createChat(projectId);
      if (!id) throw new Error(t("project_files.chat_unavailable"));
      sources.forEach(source => attach(source, id));
    },
  };
}
export function ProjectFileProvider({ children, groups, client, createChat }: { children: ReactNode; groups: WorkspaceSessionGroup[]; client: LegalworkServerClient | null; createChat: (projectId: string) => void | string | Promise<string | void> }) {
  const [dragTypes, setDragTypes] = useState<readonly string[]>([]);
  useEffect(() => {
    const start = (event: DragEvent) => {
      const types = Array.from(event.dataTransfer?.types ?? []);
      setDragTypes(previous => previous.length === types.length && previous.every((type, index) => type === types[index]) ? previous : types);
    };
    const stop = () => setDragTypes(previous => previous.length ? [] : previous);
    const leave = (event: DragEvent) => { if (!event.relatedTarget && (event.target === document || event.target === document.documentElement)) stop(); };
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragenter", start, true);
    window.addEventListener("dragend", stop, true);
    window.addEventListener("drop", stop, true);
    window.addEventListener("dragleave", leave);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragenter", start, true);
      window.removeEventListener("dragend", stop, true);
      window.removeEventListener("drop", stop, true);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", cancel);
    };
  }, []);
  const access = useMemo(() => createProjectFileAccess(groups, client, createChat), [groups, client, createChat]);
  const value = useMemo(() => ({ ...access, dragTypes }), [access, dragTypes]);
  return <ProjectFilesContext value={value}>{children}</ProjectFilesContext>;
}
export function useProjectFiles() { return use(ProjectFilesContext); }
