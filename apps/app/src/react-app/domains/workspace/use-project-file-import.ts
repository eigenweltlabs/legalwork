import { createContext, use, useRef, useState } from "react";
import type { WorkspaceCopyFilesResult } from "@legalwork/types/desktop-ipc";
import { useQueryClient } from "@tanstack/react-query";
import "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { startFileCopy } from "./file-copy-job";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";

type FileImporter = (projectId: string, files: File[], folder: string) => Promise<WorkspaceCopyFilesResult>;
/** The visual fixture supplies an in-memory importer; production uses the native bridge. */
export const ProjectFileImportContext = createContext<FileImporter | null>(null);

export function useProjectFileImport({ projectId, workspaceId, isRemoteWorkspace }: {
  projectId: string;
  workspaceId: string;
  isRemoteWorkspace: boolean;
}) {
  const queryClient = useQueryClient();
  const copyingRef = useRef(false);
  const [copying, setCopying] = useState(false);
  const importer = use(ProjectFileImportContext);
  const open = useRequestPanelTab({ kind: "workspace", workspaceId: projectId });

  const canImport = !isRemoteWorkspace && (Boolean(importer) || isElectronRuntime());

  const copyFiles = async (files: File[], destinationPath = "") => {
    if (!canImport || !files.length || copyingRef.current) return;
    const copy = importer ?? window.__LEGALWORK_ELECTRON__?.files?.copyIntoProject;
    if (!copy) { toast.info(t("projects.files_restart")); return; }
    copyingRef.current = true;
    setCopying(true);
    try {
      await Promise.all(files.map(file => startFileCopy(file.name, open, async () => {
        const result = await copy(projectId, [file], destinationPath);
        const entry = result.files[0];
        if (!entry || entry.status === "failed" || !entry.path) throw new Error(t(entry?.error === "file_only" ? "projects.files_only" : entry?.error === "recursive" ? "projects.folder_recursive" : entry?.error === "changed" ? "projects.file_changed" : entry?.error === "unavailable" ? "projects.file_unavailable" : "projects.files_copy_error"));
        for (const key of ["workspace-files", "project-files", "project-notes"]) void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
        return { path: entry.path };
      })));

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("workspaceCopyFiles") && /not implemented|unknown|not registered|unsupported/i.test(message)) {
        toast.info(t("projects.files_restart"));
      } else {
        toast.error(t("projects.files_copy_error"));
      }
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  };

  return { canImport, copying, copyFiles };
}
