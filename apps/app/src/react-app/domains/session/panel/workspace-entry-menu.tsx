import { useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, Loader2, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import type { LegalworkServerClient, LegalworkWorkspaceDirectoryEntry, LegalworkWorkspaceFileOperation } from "@/app/lib/legalwork-server";
import { FileEntryActions } from "./file-entry-actions";
import { operateWorkspaceFile } from "../../workspace/workspace-file-operation";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { isDesktopRuntime, isWindowsPlatform } from "@/app/utils";
import { joinDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { toast } from "@/components/ui/sonner";
import { useProjectFileImport } from "../../workspace/use-project-file-import";
import { useProjectFiles } from "../../workspace/project-file-context";

export function WorkspaceEntryMenu({ client, workspaceId, workspaceRoot, isRemoteWorkspace, folderPath, entry, children, className, onOpen, onRefresh, toolbar, contextOnly }: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace: boolean;
  folderPath: string;
  entry?: LegalworkWorkspaceDirectoryEntry;
  children?: ReactNode;
  className?: string;
  onOpen?: () => void;
  toolbar?: boolean;
  contextOnly?: boolean;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const projectFiles = useProjectFiles();
  const source = entry?.kind === "file" && client && workspaceId ? projectFiles?.identify(client, workspaceId, entry) : undefined;
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
    <FileEntryActions name={entry?.name ?? t("workspace_files.files")} className={className} toolbar={toolbar} contextOnly={contextOnly}
      source={source ?? undefined} onOpen={entry?.kind === "file" ? onOpen : undefined}
      file={entry?.kind === "file" && client && workspaceId ? { client, workspaceId, path: entry.path, isRemoteWorkspace } : undefined}
      pin={entry?.kind === "file" && workspaceId ? { workspaceId, source: "local", path: entry.path, name: entry.name } : undefined}
      actions={[
        ...(onOpen ? [{ label: t("storage.open"), icon: <FolderOpen />, onClick: onOpen }] : []),
        ...(!isRemoteWorkspace && isDesktopRuntime() ? [{ label: t(isWindowsPlatform() ? "workspace_list.reveal_explorer" : "workspace_list.reveal_finder"), icon: <FolderOpen />, disabled: !workspaceRoot, onClick: () => {
          void joinDesktopPath(workspaceRoot, ...(entry?.path ?? folderPath).split("/").filter(Boolean)).then(revealDesktopItemInDir).catch(() => toast.error(t("workspace_files.open_failed_title")));
        } }] : []),
        ...(isFolder ? [{ label: t("workspace_files.refresh_folder"), icon: <RefreshCw />, onClick: () => { void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId, targetFolder] }); onRefresh(); } }] : []),
        "separator",
        ...(entry?.kind === "dir" && canImport ? [{ label: t("storage.upload"), icon: <Upload />, disabled, onClick: () => uploadRef.current?.click() }] : []),
        ...(isFolder ? [{ label: t("storage.new_folder"), icon: <FolderPlus />, disabled, onClick: () => begin("mkdir") }] : []),
        ...(entry ? [
          { label: t("storage.rename"), icon: <Pencil />, disabled, onClick: () => begin("rename") },
          { label: t(isFolder ? "storage.delete_folder" : "storage.delete_file"), icon: <Trash2 />, disabled, destructive: true, onClick: () => begin("delete") },
        ] : []),
      ]}>{children}</FileEntryActions>
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
            if (operation.type === "mkdir") {
              const [result] = await client.applyWorkspaceFileOperations(workspaceId, [operation]);
              if (!result?.ok) throw new Error(result?.message ?? t("storage.failed"));
            } else {
              await operateWorkspaceFile({ client, workspaceId, path: entry!.path, isRemoteWorkspace }, operation, queryClient);
            }
            setAction(null);
          } catch (cause) { setError(cause instanceof Error ? cause.message : t("storage.failed")); }
          finally {
            setBusy(false);
            for (const key of ["workspace-files", "project-files", "project-notes", "project-file-search"]) {
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

export function WorkspaceUploadButton({ workspaceId, isRemoteWorkspace, folderPath, compact = false }: { workspaceId: string; isRemoteWorkspace: boolean; folderPath: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { canImport, copying, copyFiles } = useProjectFileImport({ projectId: workspaceId, workspaceId, isRemoteWorkspace });
  if (!canImport) return null;
  return <div className={compact ? "shrink-0" : "shrink-0 border-t border-border/70 p-2"}>
    <Button variant={compact ? "default" : "ghost"} size={compact ? "default" : "sm"} aria-label={t("storage.upload")} className={compact ? "gap-2 px-3" : "w-full justify-start text-muted-foreground"} disabled={copying} onClick={() => input.current?.click()}>
      {copying ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}{t("storage.upload")}
    </Button>
    <input ref={input} type="file" multiple hidden onChange={event => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void copyFiles(files, folderPath);
    }} />
  </div>;
}
