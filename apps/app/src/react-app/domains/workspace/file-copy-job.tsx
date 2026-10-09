import { useEffect } from "react";
import { create } from "zustand";
import { FileText, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { usePanelTabStore, type ArtifactPanelTab } from "../session/panel/panel-tab-store";

type CopiedFile = { path: string; size?: number; updatedAt?: number };
type CopyJob = { name: string; status: "copying" | "failed"; error?: string; retry: () => Promise<void> };
export const fileCopyJobs = create<{ entries: Record<string, CopyJob> }>(() => ({ entries: {} }));
let copyQueue: Promise<void> = Promise.resolve();
const exists = (id: string) => Object.values(usePanelTabStore.getState().sessions).some(session => session.tabs.some(tab => tab.type === "artifact" && tab.pendingImportId === id));
const remove = (id: string) => fileCopyJobs.setState(state => {
  const entries = { ...state.entries }; delete entries[id]; return { entries };
});

/** Publish the view before starting IO; completion never reopens a closed tab. */
export function startFileCopy(name: string, open: (tab: ArtifactPanelTab) => void, copy: () => Promise<CopiedFile>) {
  const id = `file-copy:${crypto.randomUUID()}`;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    fileCopyJobs.setState(state => ({ entries: { ...state.entries, [id]: { name, status: "copying", retry: run } } }));
    try {
      const copying = copyQueue.then(copy);
      copyQueue = copying.then(() => {}, () => {});
      const result = await copying;
      usePanelTabStore.getState().finishFileImport(id, result);
      remove(id);
    } catch (error) {
      if (exists(id)) fileCopyJobs.setState(state => ({ entries: { ...state.entries, [id]: { name, status: "failed", error: error instanceof Error ? error.message : t("projects.files_copy_error"), retry: run } } }));
      else remove(id);
    } finally { running = false; }
  };
  fileCopyJobs.setState(state => ({ entries: { ...state.entries, [id]: { name, status: "copying", retry: run } } }));
  open({ id, type: "artifact", label: name, preview: "text", pendingImportId: id });
  return run();
}

export function FileCopyPanel({ id }: { id: string }) {
  const job = fileCopyJobs(state => state.entries[id]);
  useEffect(() => () => { queueMicrotask(() => { if (!exists(id) && fileCopyJobs.getState().entries[id]?.status === "failed") remove(id); }); }, [id]);
  if (!job) return null;
  return <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center" aria-busy={job.status === "copying"}>
    {job.status === "copying" ? <Loader2 className="size-7 animate-spin text-muted-foreground" /> : <FileText className="size-7 text-muted-foreground" />}
    <p className="max-w-full truncate font-medium">{job.name}</p>
    <p role={job.status === "failed" ? "alert" : "status"} className="max-w-md text-sm text-muted-foreground">{job.status === "copying" ? t("projects.file_copy_pending") : job.error}</p>
    {job.status === "failed" && <Button variant="outline" onClick={() => void job.retry()}><RotateCw />{t("workspace_files.try_again")}</Button>}
  </div>;
}
