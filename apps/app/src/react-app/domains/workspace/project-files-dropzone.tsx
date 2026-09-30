import { useState, type ReactNode } from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { useProjectFileImport } from "./use-project-file-import";
import { t } from "@/i18n";

export function ProjectFilesDropzone({ projectId, workspaceId, isRemoteWorkspace, destinationPath = "", children }: {
  projectId: string;
  workspaceId: string;
  isRemoteWorkspace: boolean;
  destinationPath?: string;
  children: ReactNode;
}) {
  const { canImport, copying, copyFiles } = useProjectFileImport({ projectId, workspaceId, isRemoteWorkspace });
  const [over, setOver] = useState(false);
  const [dropPath, setDropPath] = useState(destinationPath);
  const destinationFor = (target: EventTarget) => target instanceof Element
    ? target.closest<HTMLElement>("[data-project-folder]")?.dataset.projectFolder ?? destinationPath
    : destinationPath;
  if (!canImport) return <>{children}</>;

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
        setDropPath(destinationFor(event.target));
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
        void copyFiles(Array.from(event.dataTransfer.files), destinationFor(event.target));
      }}
      onDragEnd={() => setOver(false)}
    >
      {children}
      {over && !copying && <div className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-background/95 p-6 text-center">
        <FolderInput className="size-8 text-muted-foreground" />
        <p className="text-base font-medium">{t("projects.files_drop_title")}</p>
        <p className="break-all text-sm text-muted-foreground">{dropPath ? t("projects.files_drop_folder", { folder: dropPath }) : t("projects.files_drop_hint")}</p>
      </div>}
      {copying && <div role="status" className="pointer-events-none absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-background px-4 py-2 text-sm shadow-sm"><Loader2 className="size-4 animate-spin" />{t("projects.files_copying")}</div>}
    </div>
  );
}
