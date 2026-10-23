import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, ArrowUpRight, CalendarDays, Copy, File, Folder, FolderOpen, Link2, ListTodo, Loader2, MessageSquare, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t } from "@/i18n";
import { DashboardIcon } from "@/react-app/design-system/dashboard-icon";
import { openDesktopFolder } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import { createProjectRemoval } from "./project-removal";

function folderParentLabel(path: string) {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  const parents = parts.slice(-3, -1);
  return parents.length ? `… / ${parents.join(" / ")}` : "";
}

function FolderLocation({ path, disabled }: { path: string; disabled: boolean }) {
  const name = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
  const parent = folderParentLabel(path);
  return <button type="button" disabled={!isDesktopRuntime() || disabled} title={`${path} — ${t("sidebar.reveal_project")}`}
    className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-blue-3/40 px-2 py-2 text-left text-blue-11 transition-colors hover:bg-blue-4/50 disabled:cursor-default disabled:hover:bg-blue-3/40"
    onClick={() => { void openDesktopFolder(path).catch(() => toast.error(t("workspace_files.open_failed_title"))); }}>
    <FolderOpen className="size-4 shrink-0" />
    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{name}</span>{parent && <span className="block truncate text-xs text-muted-foreground">{parent}</span>}</span>
    {isDesktopRuntime() && <ArrowUpRight className="size-4 shrink-0" />}
  </button>;
}

export function RemoveProjectDialog({ name, workspaceId, remote, client, onConfirm, onClose }: {
  name: string;
  workspaceId: string;
  remote: boolean;
  client: LegalworkServerClient | null;
  onConfirm: (sessionIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removal] = useState(createProjectRemoval);
  const [backupDirectory, setBackupDirectory] = useState("");
  const [manualBackupPath, setManualBackupPath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const review = useQuery({
    queryKey: ["project-deletion", client?.baseUrl, workspaceId],
    enabled: !remote && !removal.deleted,
    queryFn: () => {
      if (!client) throw new Error(t("session_route.create_server_unavailable"));
      return client.reviewProjectDeletion(workspaceId);
    },
    retry: false, staleTime: 0, gcTime: 0,
  });
  const deletesFiles = Boolean(review.data?.deleteFolder && review.data.folderExists);
  const wantsBackup = Boolean(backupDirectory) && deletesFiles;
  const editingPath = deletesFiles && manualBackupPath !== null;
  const actionDisabled = busy || picking || !removal.deleted && (editingPath || !remote && (!review.data || review.isFetching || Boolean(review.error)));
  const deletionDescription = review.data
    ? t(!review.data.folderExists ? "workspace.delete_missing_folder_description" : wantsBackup ? "workspace.delete_saved_description" : review.data.deleteFolder ? "workspace.delete_managed_description" : "workspace.delete_source_description")
    : t("workspace.delete_description");
  const chooseBackup = async () => {
    if (!client || busy || picking) return;
    setPicking(true);
    setError("");
    try {
      const selected = await client.pickWorkspaceFolder({ title: t("workspace.backup_choose") });
      if (!selected.supported) setManualBackupPath(backupDirectory);
      else if (selected.path?.trim()) {
        setBackupDirectory(selected.path.trim());
        setManualBackupPath(null);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("workspace.remove_failed"));
    } finally { setPicking(false); }
  };
  const remove = async () => {
    if (actionDisabled) return;
    setBusy(true);
    setError("");
    try {
      const result = await removal.run(async () => {
        if (remote) return { sessionIds: [] };
        if (!client) throw new Error(t("session_route.create_server_unavailable"));
        if (!review.data) throw new Error(t("workspace.delete_checking"));
        return client.deleteProject(workspaceId, review.data.token, wantsBackup ? backupDirectory.trim() : undefined);
      }, onConfirm);
      if (result.backupPath) toast.success(t("workspace.backup_saved"));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("workspace.remove_failed"));
      if (!remote && !removal.deleted) await review.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={open => { if (!open && !busy && !picking) onClose(); }}>
      <AlertDialogContent initialFocus={cancelRef} className="max-h-[90vh] overflow-y-auto data-[size=default]:sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{t(removal.deleted ? "workspace.finish_removal_title" : remote ? "workspace.remove_title" : "workspace.delete_title", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{remote ? t("workspace.remove_description") : removal.deleted ? t("workspace.finish_removal_description") : deletionDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        {removal.backupPath && <p className="text-sm">{t("workspace.backup_saved")}</p>}
        {!remote && !removal.deleted && review.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("workspace.delete_checking")}</p>}
        {!remote && !removal.deleted && review.data && <div className="space-y-3 text-sm">
          {(review.data.chatCount > 0 || review.data.taskCount > 0 || review.data.calendarEntryCount > 0 || review.data.scheduledTaskCount > 0 || review.data.unsavedDashboardCount > 0) && <section className="rounded-lg border p-3">
            <p className="font-medium">{t("workspace.deletion_will_delete")}</p>
            <ul className="mt-2 space-y-2 text-muted-foreground">
              {review.data.chatCount > 0 && <li className="flex items-center gap-2"><MessageSquare className="size-4 shrink-0" />{t("workspace.delete_chats", { count: review.data.chatCount })}</li>}
              {review.data.taskCount > 0 && <li className="flex items-center gap-2"><ListTodo className="size-4 shrink-0" />{t("workspace.delete_tasks", { count: review.data.taskCount })}</li>}
              {review.data.calendarEntryCount > 0 && <li className="flex items-center gap-2"><CalendarDays className="size-4 shrink-0" />{t("workspace.delete_calendar_entries", { count: review.data.calendarEntryCount })}</li>}
              {review.data.scheduledTaskCount > 0 && <li className="flex items-center gap-2"><AlarmClock className="size-4 shrink-0" />{t("workspace.delete_scheduled_tasks", { count: review.data.scheduledTaskCount })}</li>}
              {review.data.unsavedDashboardCount > 0 && <li className="flex items-center gap-2"><DashboardIcon className="size-4 shrink-0" />{t("workspace.delete_unsaved_dashboards", { count: review.data.unsavedDashboardCount })}</li>}
            </ul>
          </section>}
          {!review.data.folderExists && <p className="text-muted-foreground">{t("workspace.folder_already_removed")}</p>}
          {deletesFiles && !wantsBackup && <section className="rounded-lg border p-3">
            <p className="font-medium">{t("workspace.delete_folder")}</p>
            {review.data.folderItems && <>
              <p className="mt-1 text-xs text-muted-foreground">{t("workspace.folder_items")}</p>
              {review.data.folderItems.items.length > 0 && <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-muted-foreground">{(showAllFiles ? review.data.folderItems.items : review.data.folderItems.items.slice(0, 6)).map(item => <li key={item.name} className="flex items-center gap-2"><span className="shrink-0">{item.kind === "link" ? <Link2 className="size-4" /> : item.kind === "folder" ? <Folder className="size-4" /> : <File className="size-4" />}</span><span className="min-w-0 break-words">{item.name}</span></li>)}</ul>}
              {review.data.folderItems.total > 6 && <Button variant="ghost" size="sm" className="mt-2" aria-expanded={showAllFiles} onClick={() => setShowAllFiles(value => !value)}>{t(showAllFiles ? "workspace.folder_items_show_less" : "workspace.folder_items_show_all", { count: review.data.folderItems.total })}</Button>}
            </>}
            <div className="mt-3 space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex gap-2"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" /><div><p className="font-medium text-destructive">{t("workspace.backup_warning_title")}</p><p className="mt-1 text-xs text-muted-foreground">{t("workspace.backup_warning_description")}</p></div></div>
              {!editingPath && <Button variant="outline" size="sm" disabled={busy || picking} onClick={() => void chooseBackup()}>
                {picking ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}{t("workspace.backup_choose")}
              </Button>}
            </div>
          </section>}
          {review.data.folderExists && (wantsBackup || !review.data.deleteFolder) && <div className="flex items-start gap-3 rounded-lg border border-blue-6/30 bg-blue-3/20 p-3">
            <Folder className="mt-0.5 size-4 shrink-0 text-blue-11" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-blue-11">{t(wantsBackup ? "workspace.save_location_title" : "workspace.keep_folder")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t(wantsBackup ? "workspace.save_location_description" : "workspace.keep_folder_description")}</p>
              <div className="mt-2 flex items-center gap-2">
                <FolderLocation path={wantsBackup ? backupDirectory : review.data.folder} disabled={busy || picking} />
                {wantsBackup && <Button variant="ghost" size="sm" disabled={busy || picking || editingPath} onClick={() => void chooseBackup()}>{t("common.edit")}</Button>}
              </div>
            </div>
          </div>}
          {deletesFiles && manualBackupPath !== null && <div className="space-y-2 rounded-lg border p-3">
            <label htmlFor="project-backup-directory" className="font-medium">{t("workspace.backup_choose")}</label>
            <Input id="project-backup-directory" value={manualBackupPath} disabled={busy || picking} onChange={event => setManualBackupPath(event.target.value)} placeholder={t("workspace.backup_path_placeholder")} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy || picking} onClick={() => setManualBackupPath(null)}>{t("common.cancel")}</Button>
              <Button size="sm" disabled={busy || picking || !manualBackupPath.trim()} onClick={() => { setBackupDirectory(manualBackupPath.trim()); setManualBackupPath(null); setError(""); }}>{t("workspace.save_location_confirm")}</Button>
            </div>
          </div>}
          {review.data.copies.length > 0 && <section className="rounded-lg border p-3"><p className="flex items-center gap-2 font-medium"><Copy className="size-4" />{t("workspace.delete_keep_copies")}</p><p className="mt-1 text-xs text-muted-foreground">{t("workspace.delete_keep_copies_description")}</p><ul className="mt-2 max-h-40 space-y-1 overflow-auto text-muted-foreground">{review.data.copies.map((copy, index) => <li key={index} className="break-words">{copy.name} <span className="text-xs">→ {copy.projectName}</span></li>)}</ul></section>}
        </div>}
        {(error || review.error && !remote && !removal.deleted) && <p role="alert" className="text-sm text-destructive">{error || review.error?.message}</p>}
        {!remote && !removal.deleted && review.error && <Button variant="outline" disabled={busy || review.isFetching} onClick={() => void review.refetch()}>{t("common.retry")}</Button>}
        {busy && wantsBackup && !removal.deleted && <p role="status" className="text-sm text-muted-foreground">{t("workspace.backup_working")}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={busy || picking}>{t(removal.deleted ? "common.close" : "common.cancel")}</AlertDialogCancel>
          <Button variant={removal.deleted ? "default" : "destructive"} disabled={actionDisabled} aria-busy={busy} onClick={() => void remove()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t(removal.deleted ? "common.retry" : remote ? "sidebar.remove_project" : "sidebar.delete_project")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
