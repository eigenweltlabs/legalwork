import { useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, Loader2, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import type { LegalworkServerClient, LegalworkWorkspaceDirectoryEntry, LegalworkWorkspaceFileOperation } from "@/app/lib/legalwork-server";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { useProjectFileImport } from "../../workspace/use-project-file-import";

export function WorkspaceEntryMenu({ client, workspaceId, isRemoteWorkspace, folderPath, entry, children, className, onOpen, onRefresh }: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  isRemoteWorkspace: boolean;
  folderPath: string;
  entry?: LegalworkWorkspaceDirectoryEntry;
  children: ReactNode;
  className?: string;
  onOpen?: () => void;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const formId = useId();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [action, setAction] = useState<"rename" | "mkdir" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { canImport, copying, copyFiles } = useProjectFileImport({
    projectId: workspaceId ?? "", workspaceId: workspaceId ?? "", isRemoteWorkspace,
  });
  const targetFolder = entry?.kind === "dir" ? entry.path : folderPath;
  const isFolder = !entry || entry.kind === "dir";
  const disabled = busy || copying || !client || !workspaceId;
  const label = action === "delete" ? t(isFolder ? "storage.delete_folder" : "storage.delete_file")
    : action === "rename" ? t("storage.rename") : t("storage.new_folder");
  const begin = (next: "rename" | "mkdir" | "delete") => {
    setName(next === "rename" ? entry?.name ?? "" : "");
    setError("");
    setAction(next);
  };

  return <>
    <ContextMenu>
      <ContextMenuTrigger render={<div className={className} />} onContextMenu={(event) => event.stopPropagation()}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onOpen && <ContextMenuItem onClick={onOpen}><FolderOpen />{t("storage.open")}</ContextMenuItem>}
        {isFolder && <ContextMenuItem onClick={() => {
          void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId, targetFolder] });
          onRefresh();
        }}><RefreshCw />{t("workspace_files.refresh_folder")}</ContextMenuItem>}
        <ContextMenuSeparator />
        {isFolder && canImport && <ContextMenuItem disabled={disabled} onClick={() => uploadRef.current?.click()}><Upload />{t("storage.upload")}</ContextMenuItem>}
        {isFolder && <ContextMenuItem disabled={disabled} onClick={() => begin("mkdir")}><FolderPlus />{t("storage.new_folder")}</ContextMenuItem>}
        {entry && <>
          <ContextMenuItem disabled={disabled} onClick={() => begin("rename")}><Pencil />{t("storage.rename")}</ContextMenuItem>
          <ContextMenuItem disabled={disabled} variant="destructive" onClick={() => begin("delete")}><Trash2 />{t(isFolder ? "storage.delete_folder" : "storage.delete_file")}</ContextMenuItem>
        </>}
      </ContextMenuContent>
    </ContextMenu>
    {canImport && <input ref={uploadRef} type="file" multiple hidden onChange={(event) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void copyFiles(files, targetFolder);
    }} />}
    <Dialog open={action !== null} onOpenChange={(open) => { if (!busy && !open) setAction(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{action === "delete"
            ? t(isFolder ? "workspace_files.delete_folder_confirm" : "workspace_files.delete_file_confirm", { name: entry?.name ?? "" })
            : entry?.path || folderPath || t("workspace_files.files")}</DialogDescription>
        </DialogHeader>
        <form id={formId} onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || !client || !workspaceId || !action) return;
          const trimmed = name.trim();
          if (action !== "delete" && (!trimmed || /[/\\\x00-\x1f\x7f]/.test(trimmed) || trimmed === "." || trimmed === "..")) {
            setError(t("workspace_files.invalid_name")); return;
          }
          const join = (folder: string, leaf: string) => folder ? `${folder}/${leaf}` : leaf;
          let operation: LegalworkWorkspaceFileOperation;
          if (action === "mkdir") operation = { type: "mkdir", path: join(targetFolder, trimmed), exclusive: true };
          else if (!entry) return;
          else if (action === "rename") operation = { type: "rename", from: entry.path, to: join(folderPath, trimmed), overwrite: false };
          else operation = { type: "delete", path: entry.path, recursive: entry.kind === "dir" };
          setBusy(true); setError("");
          try {
            const [result] = await client.applyWorkspaceFileOperations(workspaceId, [operation]);
            if (!result?.ok) throw new Error(result?.message ?? t("storage.failed"));
            if (entry && action !== "mkdir") {
              // Discard cached note content at the old path, including notes inside removed folders.
              const filter = { predicate: (query: { queryKey: readonly unknown[] }) =>
                query.queryKey[0] === "markdown-editor" && query.queryKey[1] === workspaceId &&
                typeof query.queryKey[2] === "string" && (query.queryKey[2] === entry.path || query.queryKey[2].startsWith(`${entry.path}/`)) };
              await queryClient.cancelQueries(filter);
              queryClient.removeQueries(filter);
            }
            setAction(null);
          } catch (cause) { setError(cause instanceof Error ? cause.message : t("storage.failed")); }
          finally {
            setBusy(false);
            for (const key of ["workspace-files", "project-files", "project-notes"]) {
              void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
            }
          }
        }}>
          {action !== "delete" && <Input autoFocus value={name} maxLength={255} disabled={busy}
            aria-label={t(action === "rename" ? "storage.new_name" : "storage.folder_name")}
            onChange={(event) => setName(event.target.value)} />}
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>{t("common.cancel")}</Button>
          <Button type="submit" form={formId} variant={action === "delete" ? "destructive" : "default"}
            disabled={disabled || (action !== "delete" && !name.trim()) || (action === "rename" && name.trim() === entry?.name)}>
            {busy && <Loader2 className="size-4 animate-spin" />}{label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
