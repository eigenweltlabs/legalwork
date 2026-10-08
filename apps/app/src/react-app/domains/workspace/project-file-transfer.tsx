import { useState, type DragEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import { Copy, Link2, Loader2 } from "lucide-react";
import { hasProjectFileDrag, readProjectFileDrag } from "@/app/lib/project-file-drag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useProjectFiles } from "./project-file-context";

export function ProjectFileDropTarget({ projectId, folder = "", mode = "files", children, className = "" }: { projectId: string; folder?: string; mode?: "files" | "chat"; children: ReactNode; className?: string }) {
  const files = useProjectFiles();
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<{ source: ProjectFileSource; folder: string } | null>(null);
  const destination = (event: DragEvent) => event.target instanceof Element ? event.target.closest<HTMLElement>("[data-project-folder]")?.dataset.projectFolder ?? folder : folder;
  return <div className={`relative ${className}`} data-project-file-drop={projectId}
    onDragEnter={event => { if (files && hasProjectFileDrag(event.dataTransfer)) { event.preventDefault(); event.stopPropagation(); setOver(true); } }}
    onDragOver={event => { if (!files || !hasProjectFileDrag(event.dataTransfer)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setOver(true); }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false); }}
    onDrop={event => {
      if (!hasProjectFileDrag(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setOver(false);
      const source = readProjectFileDrag(event.dataTransfer);
      if (!source || !files) return;
      if (mode === "chat") void files.newChat(projectId, source).catch(error => toast.error(error.message));
      else setPending({ source, folder: destination(event) });
    }} onDragEnd={() => setOver(false)}>
    {children}
    {over && <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-primary bg-background/95 px-2 py-1 text-center text-xs font-medium">{t(mode === "chat" ? "project_files.drop_chat" : "project_files.drop_add")}</div>}
    {pending && <ProjectFileTransfer key={`${pending.source.projectId}:${pending.source.path}:${pending.folder}`} projectId={projectId} source={pending.source} folder={pending.folder} onClose={() => setPending(null)} />}
  </div>;
}

export function ProjectFileTransfer({ projectId, source, folder, onClose }: { projectId: string; source: ProjectFileSource; folder: string; onClose: () => void }) {
  const files = useProjectFiles();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"copy" | "link">("copy");
  const [name, setName] = useState(source.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const target = files?.projects.find(project => project.projectId === projectId);
  const owner = files?.projects.find(project => project.projectId === source.projectId);
  const submit = async () => {
    if (!files || !target || busy) return;
    setBusy(true); setError("");
    try {
      if (!name.trim() || /[\/\\\u0000-\u001f]/.test(name) || name === "." || name === "..") throw new Error(t("project_files.invalid_name"));
      const path = folder ? `${folder}/${name.trim()}` : name.trim();
      if (mode === "copy") {
        const saved = await files.readSaved(source);
        await target.client.importProjectFile(target.workspaceId, path, source, saved.data);
      } else {
        files.sourceProject(source);
        await target.client.updateProjectFileLink(target.workspaceId, { name: name.trim(), folder, source });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-files", target.workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["project-file-links", target.client.baseUrl, target.workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["project-file-search", target.workspaceId] }),
      ]);
      toast.success(t(mode === "copy" ? "project_files.copied" : "project_files.linked", { project: target.name }));
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : t("project_files.failed")); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t("project_files.add_title", { project: target?.name ?? projectId })}</DialogTitle><DialogDescription>{t("project_files.add_description", { file: source.name, project: owner?.name ?? source.projectId })}</DialogDescription></DialogHeader>
    <div className="grid gap-2" role="group" aria-label={t("project_files.add_method")}>
      <Button disabled={busy} variant={mode === "copy" ? "secondary" : "outline"} className="h-auto justify-start gap-3 whitespace-normal py-3 text-left" aria-pressed={mode === "copy"} onClick={() => setMode("copy")}><Copy className="size-4 shrink-0" /><span><span className="block">{t("project_files.copy")}</span><span className="block text-xs font-normal text-muted-foreground">{t("project_files.copy_hint")}</span></span></Button>
      <Button disabled={busy} variant={mode === "link" ? "secondary" : "outline"} className="h-auto justify-start gap-3 whitespace-normal py-3 text-left" aria-pressed={mode === "link"} onClick={() => setMode("link")}><Link2 className="size-4 shrink-0" /><span><span className="block">{t("project_files.link")}</span><span className="block text-xs font-normal text-muted-foreground">{t("project_files.link_hint")}</span></span></Button>
    </div>
    <label className="space-y-1 text-sm">{t("project_files.name")}<Input disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
    <p className="text-xs text-muted-foreground">{t("project_files.destination", { folder: folder || target?.name || projectId })}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button disabled={busy || !target} onClick={() => void submit()}>{busy && <Loader2 className="size-4 animate-spin" />}{t(mode === "copy" ? "project_files.copy" : "project_files.link")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
