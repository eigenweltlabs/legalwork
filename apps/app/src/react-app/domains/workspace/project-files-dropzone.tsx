import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderInput, Loader2 } from "lucide-react";
import "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

export function ProjectFilesDropzone({ projectId, workspaceId, isRemoteWorkspace, destinationPath = "", children }: {
  projectId: string;
  workspaceId: string;
  isRemoteWorkspace: boolean;
  destinationPath?: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const copyingRef = useRef(false);
  const [copying, setCopying] = useState(false);
  const [over, setOver] = useState(false);

  // Native paths are available only for local desktop projects.
  if (isRemoteWorkspace || !isElectronRuntime()) return <>{children}</>;

  const copyFiles = async (files: File[]) => {
    if (!files.length || copyingRef.current) return;
    const copy = window.__LEGALWORK_ELECTRON__?.files?.copyIntoProject;
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

  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      aria-busy={copying}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = copying ? "none" : "copy";
        setOver(!copying);
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        void copyFiles(Array.from(event.dataTransfer.files));
      }}
      onDragEnd={() => setOver(false)}
    >
      {children}
      {over && !copying && <div className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-background/95 p-6 text-center">
        <FolderInput className="size-8 text-muted-foreground" />
        <p className="text-base font-medium">{t("projects.files_drop_title")}</p>
        <p className="break-all text-sm text-muted-foreground">{destinationPath ? t("projects.files_drop_folder", { folder: destinationPath }) : t("projects.files_drop_hint")}</p>
      </div>}
      {copying && <div role="status" className="pointer-events-none absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-background px-4 py-2 text-sm shadow-sm"><Loader2 className="size-4 animate-spin" />{t("projects.files_copying")}</div>}
    </div>
  );
}
