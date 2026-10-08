import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectFileSource } from "@legalwork/types/project-files";
import { Check, Copy, Link2, Loader2 } from "lucide-react";
import { canTransferProjectFiles, hasProjectFileDrag, projectFileDragOriginatesHere, readProjectFilesDrag } from "@/app/lib/project-file-drag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { fileTransferItems, transferFileBatch } from "./project-file-batch";
import { useProjectFiles } from "./project-file-context";

export function ProjectFileDropTarget({ projectId, folder = "", mode = "files", hint = false, children, className = "" }: { projectId: string; folder?: string; mode?: "files" | "chat"; hint?: boolean; children: ReactNode; className?: string }) {
  const files = useProjectFiles();
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<{ sources: ProjectFileSource[]; folder: string } | null>(null);
  const project = files?.projects.find(project => project.projectId === projectId);
  const accepts = (data: Pick<DataTransfer, "types">) => Boolean(project) && (mode === "chat" ? hasProjectFileDrag(data) : canTransferProjectFiles(data, projectId));
  const ready = accepts({ types: files?.dragTypes ?? [] });
  const label = t(mode === "chat" ? "project_files.drop_chat_in" : "project_files.drop_transfer_to", { project: project?.name ?? projectId });
  const destination = (event: DragEvent) => event.target instanceof Element ? event.target.closest<HTMLElement>("[data-project-folder]")?.dataset.projectFolder ?? folder : folder;
  return <div className={`relative ${hint && ready ? "rounded-md outline outline-1 outline-dashed outline-primary/50" : ""} ${className}`} data-workspace-file-intake={mode === "files" ? `project:${projectId}` : undefined} data-project-file-drop={projectId} title={hint && ready ? label : undefined}
    onDragEnter={event => { if (accepts(event.dataTransfer)) { event.preventDefault(); event.stopPropagation(); setOver(true); } }}
    onDragOver={event => { if (!accepts(event.dataTransfer)) { setOver(false); return; } event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setOver(true); }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false); }}
    onDrop={event => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setOver(false);
      const sources = readProjectFilesDrag(event.dataTransfer);
      if (!sources.length || !files) return;
      if (mode === "files" && (projectFileDragOriginatesHere(event.dataTransfer, projectId) || sources.some(source => source.projectId === projectId))) return;
      if (mode === "chat") void files.newChat(projectId, sources).catch(error => toast.error(error.message));
      else setPending({ sources, folder: destination(event) });
    }} onDragEnd={() => setOver(false)}>
    {children}
    {over && ready && <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border border-primary/40 bg-background/95 px-2 py-1 text-center text-xs font-medium">{label}</div>}
    {pending && <ProjectFileTransfer projectId={projectId} sources={pending.sources} folder={pending.folder} onClose={() => setPending(null)} />}
  </div>;
}

export function ProjectFileTransfer({ projectId, sources, folder, initialMode = "copy", onClose }: { projectId?: string; sources: ProjectFileSource[]; folder: string; initialMode?: "copy" | "link"; onClose: () => void }) {
  const files = useProjectFiles();
  const queryClient = useQueryClient();
  const [destinationId, setDestinationId] = useState(projectId ?? "");
  const destinations = files?.projects.filter(project => !sources.some(source => source.projectId === project.projectId)) ?? [];
  const [mode, setMode] = useState(initialMode);
  const [items, setItems] = useState(() => fileTransferItems(sources));
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const target = files?.projects.find(project => project.projectId === destinationId);
  const completed = items.filter(item => item.done).length;
  const locked = busy || completed > 0;
  const submit = async () => {
    if (!files || !target || submitting.current) return;
    submitting.current = true; setBusy(true);
    try {
      const results = await transferFileBatch(items, async item => {
        const name = item.name.trim();
        if (!name || /[\/\\\u0000-\u001f\u007f]/.test(name) || name === "." || name === "..") throw new Error(t("project_files.invalid_name"));
        const path = folder ? `${folder}/${name}` : name;
        if (mode === "copy") {
          const saved = await files.readSaved(item.source);
          await target.client.importProjectFile(target.workspaceId, path, item.source, saved.data);
        } else {
          files.sourceProject(item.source);
          await target.client.updateProjectFileLink(target.workspaceId, { name, folder, source: item.source });
        }
      }, setItems);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-files", target.workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["project-file-links", target.client.baseUrl, target.workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["project-file-search", target.workspaceId] }),
      ]);
      if (results.every(item => item.done)) {
        toast.success(t(mode === "copy" ? "project_files.copied" : "project_files.linked", { project: target.name }));
        onClose();
      }
    } finally { submitting.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-hidden">
    <DialogHeader><DialogTitle>{target ? t("project_files.add_title", { project: target.name }) : t("project_files.choose_project")}</DialogTitle><DialogDescription>{t("project_files.transfer_description", { count: items.length })}</DialogDescription></DialogHeader>
    {!projectId && <Select value={destinationId || null} disabled={locked} onValueChange={value => { setDestinationId(value ?? ""); setItems(items => items.map(item => ({ ...item, error: "" }))); }}>
      <SelectTrigger className="w-full" aria-label={t("project_files.choose_project")}><SelectValue placeholder={t("project_files.choose_project")}>{target?.name}</SelectValue></SelectTrigger>
      <SelectContent>{destinations.map(project => <SelectItem key={project.projectId} value={project.projectId}>{project.name}</SelectItem>)}</SelectContent>
    </Select>}
    <RadioGroup disabled={locked} value={mode} onValueChange={value => { if (value === "copy" || value === "link") setMode(value); }} className="gap-2 rounded-xl bg-muted/40 p-2" aria-label={t("project_files.add_method")}>
      {(["copy", "link"] satisfies Array<typeof mode>).map(value => <label key={value} className={cn("flex items-center gap-3 rounded-lg border border-transparent px-3 py-3 text-sm transition-colors", locked ? "opacity-60" : "cursor-pointer hover:bg-background/60", mode === value && "border-border bg-background shadow-sm hover:bg-background")}>
        <RadioGroupItem value={value} />{value === "copy" ? <Copy className="size-4 shrink-0" /> : <Link2 className="size-4 shrink-0" />}
        <span><span className="block font-medium">{t(value === "copy" ? "project_files.copy" : "project_files.link")}</span><span className="block text-xs text-muted-foreground">{t(value === "copy" ? "project_files.copy_hint" : "project_files.link_hint")}</span></span>
      </label>)}
    </RadioGroup>
    <div className="min-h-0 max-h-64 flex-1 space-y-3 overflow-auto pr-1">{items.map((item, index) => <div key={index} className="space-y-1">
      <label className="block space-y-1 text-sm"><span className="flex items-center gap-2"><span className="truncate">{item.source.name}</span>{item.done && <Check className="size-4 shrink-0 text-emerald-600" aria-label={t("project_files.transfer_done")} />}</span>
        <Input disabled={busy || item.done} value={item.name} aria-label={t("project_files.destination_name", { name: item.source.name })} onChange={event => setItems(current => current.map((entry, position) => position === index ? { ...entry, name: event.target.value, error: "" } : entry))} />
      </label>
      <p className="truncate text-xs text-muted-foreground">{t("project_files.origin", { project: files?.projects.find(project => project.projectId === item.source.projectId)?.name ?? item.source.projectId })}</p>
      {item.error && <p role="alert" className="text-xs text-destructive">{item.error}</p>}
    </div>)}</div>
    <p className="text-xs text-muted-foreground" role="status">{completed ? t("project_files.transfer_progress", { completed, count: items.length }) : target ? t("project_files.destination", { folder: folder || target.name }) : t("project_files.choose_project")}</p>
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>{t(completed ? "common.close" : "common.cancel")}</Button><Button disabled={busy || !target || !items.length} onClick={() => void submit()}>{busy && <Loader2 className="size-4 animate-spin" />}{t(items.some(item => item.error) ? "project_files.retry_remaining" : mode === "copy" ? "project_files.copy" : "project_files.link")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
