import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderInput, Loader2 } from "lucide-react";
import "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export function ProjectFilesDropzone({ projectId, workspaceId, isRemoteWorkspace }: {
  projectId: string;
  workspaceId: string;
  isRemoteWorkspace: boolean;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const movingRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const [over, setOver] = useState(false);

  // A browser cannot move files off the user's computer. Only local desktop
  // projects offer this action, with their registered folder as destination.
  if (isRemoteWorkspace || !isElectronRuntime()) return null;

  const moveFiles = async (files: File[]) => {
    if (!files.length || movingRef.current) return;
    const move = window.__LEGALWORK_ELECTRON__?.files?.moveIntoProject;
    if (!move) { toast.info(t("projects.files_restart")); return; }
    movingRef.current = true;
    setMoving(true);
    try {
      const result = await move(projectId, files);
      const moved = result.files.filter((file) => file.status === "moved").length;
      const existing = result.files.filter((file) => file.status === "already_here").length;
      if (moved) toast.success(t(moved === 1 ? "projects.files_moved_one" : "projects.files_moved_other", { count: moved }));
      if (existing && !moved) toast.info(t("projects.files_already_here"));
      for (const file of result.files.filter((entry) => entry.status === "failed")) {
        toast.error(t("projects.file_move_failed", { name: file.name }), {
          description: t(file.error === "file_only" ? "projects.files_only"
            : file.error === "changed" ? "projects.file_changed"
              : file.error === "unavailable" ? "projects.file_unavailable" : "projects.files_move_error"),
        });
      }
      if (moved) {
        void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["project-files", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["project-notes", workspaceId] });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("workspaceMoveFiles") && /not implemented|unknown|not registered|unsupported/i.test(message)) {
        toast.info(t("projects.files_restart"));
      } else {
        toast.error(t("projects.files_move_error"));
      }
    } finally {
      movingRef.current = false;
      setMoving(false);
    }
  };

  return (
    <Surface
      className={cn("mb-8 flex flex-wrap items-center gap-3 rounded-xl border-dashed px-4 py-4 transition-colors", over && "border-foreground/40 bg-muted/40")}
      aria-label={t("projects.files_drop_title")}
      aria-busy={moving}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = moving ? "none" : "move";
        setOver(!moving);
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        void moveFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {moving ? <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" /> : <FolderInput className="size-5 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1 basis-48">
        <p role="status" className="text-sm font-medium">{t(moving ? "projects.files_moving" : "projects.files_drop_title")}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("projects.files_drop_hint")}</p>
      </div>
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        void moveFiles(files);
      }} />
      <Button variant="outline" size="sm" disabled={moving} onClick={() => inputRef.current?.click()}>{t("projects.files_choose")}</Button>
    </Surface>
  );
}
