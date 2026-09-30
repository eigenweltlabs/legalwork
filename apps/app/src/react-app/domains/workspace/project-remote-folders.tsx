import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, Plus, RefreshCw, Unlink } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { RemoteFolderPicker, useRemoteFolderSources } from "./remote-folder-picker";

export function ProjectLinkedFoldersSection({ client, workspaceId }: { client: LegalworkServerClient; workspaceId: string }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const sources = useRemoteFolderSources(client);
  const queries = useQueryClient();
  const linked = useQuery({ queryKey: ["project-remote-folders", workspaceId], queryFn: () => client.projectRemoteFolders(workspaceId), retry: false });
  const refresh = async () => { await Promise.all([
    queries.invalidateQueries({ queryKey: ["project", workspaceId] }),
    queries.invalidateQueries({ queryKey: ["project-remote-folders", workspaceId] }),
    queries.invalidateQueries({ queryKey: ["storage-roots", workspaceId] }),
  ]); };
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); await refresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : t("projects.failed")); }
    finally { setBusy(false); }
  };
  return <>
    <div className="space-y-4">
      <div className="space-y-1"><h3 className="font-medium">{t("projects.remote.linked")}</h3><p className="text-sm text-muted-foreground">{t("projects.remote.sharing_hint")}</p></div>
      <div className="space-y-3">
        {linked.isPending && <p className="text-sm text-muted-foreground">{t("projects.loading")}</p>}
        {!linked.isPending && !linked.error && !linked.data?.folders.length ? <p className="text-sm text-muted-foreground">{t("project_settings.no_folders")}</p> : null}
        {sources.error ? <p role="alert" className="text-sm text-destructive">{sources.error.message}</p> : null}
        {linked.error && <p role="alert" className="text-sm text-destructive">{linked.error.message}</p>}
        {linked.data?.folders.map((folder) => <div key={folder.location.id} className="rounded-xl border p-3">
          <div className="flex items-center gap-2"><Folder className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate font-medium">{folder.location.folder.name}</span><Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("projects.remote.unlink")} title={t("projects.remote.unlink")} onClick={() => { void mutate(async () => { const current = await client.getProjectDetails(workspaceId); return client.unlinkProjectFolder(workspaceId, current.revision, folder.location.id); }); }}><Unlink /></Button></div>
          <p className="truncate text-xs text-muted-foreground" title={folder.location.folder.path}>{folder.location.connectionName} / {folder.location.folder.path || "/"}</p>
          {folder.error ? <p role="status" className="mt-2 text-sm text-destructive">{folder.error}</p> : <p className="mt-2 text-xs text-muted-foreground">{t("projects.remote.available")}</p>}
        </div>)}
        {linked.data?.initialization === "pending" && <p className="text-sm text-muted-foreground">{t("projects.remote.pending")}</p>}
      </div>
      <div className="flex justify-between"><Button variant="ghost" disabled={busy || linked.isFetching} onClick={() => { void linked.refetch(); void sources.refetch(); }}><RefreshCw />{t("projects.remote.refresh")}</Button><Button disabled={busy || !sources.data?.sources.length} onClick={() => setPicking(true)}><Plus />{t("projects.remote.link")}</Button></div>
    </div>
    {picking && <RemoteFolderPicker client={client} sources={sources.data?.sources ?? []} onClose={() => setPicking(false)} onSelect={(folder) => { setPicking(false); void mutate(async () => { const current = await client.getProjectDetails(workspaceId); return client.linkProjectFolders(workspaceId, current.revision, [{ sourceWorkspaceId: folder.sourceWorkspaceId, connectionId: folder.connectionId, path: folder.path }]); }); }} />}
  </>;
}
