import { useEffect, useRef, type DragEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { hasWorkspaceFileMove, readWorkspaceFileMove, workspaceFileMoves } from "@/app/lib/workspace-file-move";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { operateWorkspaceFile } from "./workspace-file-operation";

export function WorkspaceFileMoveTarget({ client, workspaceId, isRemoteWorkspace, folder, children }: {
  client: LegalworkServerClient | null; workspaceId: string | null; isRemoteWorkspace: boolean; folder: string; children: ReactNode;
}) {
  const queries = useQueryClient();
  const busy = useRef(false);
  const highlighted = useRef<HTMLElement | null>(null);
  const clear = () => { highlighted.current?.removeAttribute("data-file-move-over"); highlighted.current = null; };
  useEffect(() => {
    window.addEventListener("dragend", clear); window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); highlighted.current?.removeAttribute("data-file-move-over"); };
  }, []);
  const accepts = (data: Pick<DataTransfer, "types">) => Boolean(client && workspaceId && hasWorkspaceFileMove(data, client.baseUrl, workspaceId));
  const targetFolder = (target: EventTarget) => target instanceof Element ? target.closest<HTMLElement>("[data-project-folder]") : null;
  const indicateMove = (event: DragEvent) => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy.current ? "none" : "move";
      const target = targetFolder(event.target);
      if (highlighted.current !== target) { highlighted.current?.removeAttribute("data-file-move-over"); highlighted.current = target; }
      target?.setAttribute("data-file-move-over", "true");
  };
  return <div className="relative flex h-full min-h-0 flex-1 flex-col" data-file-explorer data-workspace-file-intake="explorer"
    onDragEnter={indicateMove} onDragOver={indicateMove}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clear(); }}
    onDrop={event => {
      if (!accepts(event.dataTransfer) || !client || !workspaceId) return;
      event.preventDefault(); event.stopPropagation();
      const destination = targetFolder(event.target)?.dataset.projectFolder ?? folder;
      const paths = readWorkspaceFileMove(event.dataTransfer, client.baseUrl, workspaceId);
      clear();
      if (busy.current || !paths.length) return;
      busy.current = true;
      void (async () => {
        const failures: string[] = [];
        for (const operation of workspaceFileMoves(paths, destination)) {
          try { await operateWorkspaceFile({ client, workspaceId, path: operation.from, isRemoteWorkspace }, operation, queries); }
          catch (error) { failures.push(`${operation.from}: ${error instanceof Error ? error.message : t("storage.failed")}`); }
        }
        if (failures.length) toast.error(failures.join("\n"));
      })().finally(() => { busy.current = false; });
    }}>
    {children}
  </div>;
}
