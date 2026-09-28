import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Folder, LoaderCircle } from "lucide-react";
import type { RemoteFolderSelection } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

export type FolderSource = Omit<RemoteFolderSelection, "path"> & { name: string };
export type SelectedRemoteFolder = RemoteFolderSelection & { name: string; connectionName: string };
export function useRemoteFolderSources(client: LegalworkServerClient | null, enabled = true) {
  return useQuery({ queryKey: ["project-folder-sources", client], queryFn: () => client!.projectFolderSources(), enabled: Boolean(client) && enabled, staleTime: 15_000 });
}
export function RemoteFolderPicker(props: {
  client: LegalworkServerClient; sources: FolderSource[]; onClose: () => void;
  onSelect: (folder: SelectedRemoteFolder) => void;
}) {
  const [source, setSource] = useState<FolderSource | null>(null);
  const [path, setPath] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const page = useQuery({
    queryKey: ["project-folder-picker", source?.sourceWorkspaceId, source?.connectionId, path, cursor],
    queryFn: () => props.client.storageChildren(source!.sourceWorkspaceId, source!.connectionId, path, cursor),
    enabled: Boolean(source), retry: false,
  });
  const changePath = (value: string) => { setPath(value); setCursor(undefined); };
  return <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent className="rounded-3xl sm:max-w-xl">
      <DialogHeader><DialogTitle>{t("projects.remote.choose")}</DialogTitle><DialogDescription>{t("projects.remote.reference_hint")}</DialogDescription></DialogHeader>
      {source ? <div className="flex items-center gap-2 text-sm">
        <Button variant="ghost" size="icon-sm" aria-label={t("projects.remote.back")} onClick={() => path ? changePath(path.split("/").slice(0, -1).join("/")) : setSource(null)}><ArrowLeft /></Button>
        <span className="min-w-0 truncate" title={`${source.name}/${path}`}>{source.name}{path ? ` / ${path}` : ""}</span>
      </div> : null}
      <div className="min-h-48 max-h-72 overflow-y-auto rounded-xl border p-2">
        {!source ? props.sources.map((item) => <Button key={`${item.sourceWorkspaceId}:${item.connectionId}`} variant="ghost" className="w-full justify-start" onClick={() => { setSource(item); changePath(""); }}><Folder /><span className="truncate">{item.name}</span><ChevronRight className="ml-auto" /></Button>) : page.isPending ? <LoaderCircle className="mx-auto mt-16 animate-spin" /> : page.error ? <p role="alert" className="p-3 text-sm text-destructive">{page.error.message}</p> : <>
          {page.data.entries.filter((item) => item.kind === "folder").map((item) => <Button key={item.path} variant="ghost" className="w-full justify-start" onClick={() => changePath(item.path)}><Folder /><span className="truncate">{item.name}</span><ChevronRight className="ml-auto" /></Button>)}
          {!page.data.entries.some((item) => item.kind === "folder") && <p className="p-3 text-sm text-muted-foreground">{t("projects.remote.no_subfolders")}</p>}
          {page.data.nextCursor && <Button variant="ghost" onClick={() => setCursor(page.data.nextCursor)}>{t("projects.remote.next_page")}</Button>}
        </>}
      </div>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={props.onClose}>{t("projects.cancel")}</Button><Button disabled={!source || !page.data || page.isFetching || Boolean(page.error)} onClick={() => { if (source) props.onSelect({ sourceWorkspaceId: source.sourceWorkspaceId, connectionId: source.connectionId, path, name: path.split("/").at(-1) || source.name, connectionName: source.name }); }}>{t("projects.remote.use_folder")}</Button></div>
    </DialogContent>
  </Dialog>;
}
