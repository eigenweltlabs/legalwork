import { createContext, use, useRef, useState } from "react";
import type { WorkspaceCopyFilesResult } from "@legalwork/types/desktop-ipc";
import { useQueryClient } from "@tanstack/react-query";
import "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

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

  const canImport = !isRemoteWorkspace && (Boolean(importer) || isElectronRuntime());

  const copyFiles = async (files: File[], destinationPath = "") => {
    if (!canImport || !files.length || copyingRef.current) return;
    const copy = importer ?? window.__LEGALWORK_ELECTRON__?.files?.copyIntoProject;
    if (!copy) { toast.info(t("projects.files_restart")); return; }
    copyingRef.current = true;
    setCopying(true);
    try {
      const result = await copy(projectId, files, destinationPath);
      const copied = result.files.filter((file) => file.status === "copied").length;
      const existing = result.files.filter((file) => file.status === "already_here").length;
      if (copied) toast.success(t(copied === 1 ? "projects.files_copied_one" : "projects.files_copied_other", { count: copied }));
      if (existing && !copied) toast.info(t("projects.files_already_here"));
      for (const file of result.files.filter((entry) => entry.status === "failed")) {
        toast.error(t("projects.file_copy_failed", { name: file.name }), {
          description: t(file.error === "file_only" ? "projects.files_only"
            : file.error === "recursive" ? "projects.folder_recursive"
            : file.error === "changed" ? "projects.file_changed"
              : file.error === "unavailable" ? "projects.file_unavailable" : "projects.files_copy_error"),
        });
      }
      if (copied) {
        void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["project-files", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["project-notes", workspaceId] });
      }
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
