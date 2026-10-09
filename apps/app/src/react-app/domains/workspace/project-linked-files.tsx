import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Pencil, Unlink } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { ProjectFileLink } from "@legalwork/types/project-files";
import { writeProjectFileDrag } from "@/app/lib/project-file-drag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { FileEntryActions } from "../session/panel/file-entry-actions";
import { useFilePins, changePinnedPaths } from "../session/panel/file-pins";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { projectFileTab } from "./project-file-tab";
import { useProjectFiles } from "./project-file-context";

export function ProjectLinkedFiles({ client, workspaceId, projectId, folder, query, active }: { client: LegalworkServerClient; workspaceId: string; projectId: string; folder: string; query: string; active: boolean }) {
  const requestPanelTab = useRequestPanelTab({ kind: "workspace", workspaceId: projectId });
  const access = useProjectFiles();
  const cache = useQueryClient();
  const pins = useFilePins();
  const [renaming, setRenaming] = useState<ProjectFileLink | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = ["project-file-links", client.baseUrl, workspaceId];
  const links = useQuery({ queryKey: key, queryFn: () => client.projectFileLinks(workspaceId), enabled: active, refetchInterval: active ? 2000 : false });
  const pinned = (link: ProjectFileLink) => pins.some(pin => pin.workspaceId === workspaceId && pin.source === "project-link" && pin.path === link.id);
  const visible = (links.data?.links ?? []).filter(link => query.trim() ? `${link.name} ${access?.projects.find(p => p.projectId === link.source.projectId)?.name ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) : link.folder === folder || pinned(link)).sort((a,b) => Number(pinned(b)) - Number(pinned(a)) || a.name.localeCompare(b.name));
  const remove = async (link: ProjectFileLink) => {
    try { await client.updateProjectFileLink(workspaceId, { id: link.id, remove: true }); changePinnedPaths(workspaceId, "project-link", link.id); await cache.invalidateQueries({ queryKey: key }); }
    catch (error) { toast.error(error instanceof Error ? error.message : t("project_files.failed")); }
  };
  const rename = async () => {
    if (!renaming || busy) return;
    setBusy(true); setError("");
    try { await client.updateProjectFileLink(workspaceId, { ...renaming, name: name.trim() }); await cache.invalidateQueries({ queryKey: key }); setRenaming(null); }
    catch (error) { setError(error instanceof Error ? error.message : t("project_files.failed")); }
    finally { setBusy(false); }
  };
  if (links.isError) return <p role="status" className="p-2 text-xs text-muted-foreground">{t("project_files.links_unavailable")} <button className="underline" onClick={() => void links.refetch()}>{t("workspace_files.try_again")}</button></p>;
  if (!visible.length) return null;
  return <section className="mb-3 border-b border-border/60 pb-3" aria-label={t("project_files.linked_files")}>
    <h3 className="px-2 py-2 text-xs font-medium text-muted-foreground">{t("project_files.linked_files")}</h3>
    {visible.map(link => <FileEntryActions key={link.id} name={link.name} source={link.source} onOpen={() => requestPanelTab(projectFileTab(link.source))} pin={{ workspaceId, source: "project-link", path: link.id, name: link.name }} actions={[
      { label: t("project_files.rename_link"), icon: <Pencil />, onClick: () => { setName(link.name); setRenaming(link); setError(""); } },
      { label: t("project_files.remove_link"), icon: <Unlink />, onClick: () => void remove(link) },
    ]}><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/50" draggable onDragStart={event => writeProjectFileDrag(event.dataTransfer, link.source, projectId)} onClick={() => requestPanelTab(projectFileTab(link.source))} title={link.source.path}>
      <Link2 className="size-4 shrink-0 text-primary" /><span className="min-w-0"><span className="block truncate text-[13px]">{link.name}</span><span className="block truncate text-[11px] text-muted-foreground">{t("project_files.origin", { project: access?.projects.find(p => p.projectId === link.source.projectId)?.name ?? link.source.projectId })}</span></span>
    </button></FileEntryActions>)}
    <Dialog open={Boolean(renaming)} onOpenChange={open => { if (!open && !busy) setRenaming(null); }}><DialogContent><DialogTitle>{t("project_files.rename_link")}</DialogTitle><DialogDescription>{t("project_files.rename_link_hint")}</DialogDescription><Input value={name} disabled={busy} onChange={event => setName(event.target.value)} aria-label={t("project_files.name")} />{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setRenaming(null)}>{t("common.cancel")}</Button><Button disabled={busy || !name.trim()} onClick={() => void rename()}>{t("common.save")}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
