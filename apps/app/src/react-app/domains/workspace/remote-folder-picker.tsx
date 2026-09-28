import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Cloud, LoaderCircle } from "lucide-react";
import type { RemoteFolderSelection } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
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
    <DialogContent className="max-h-[calc(100dvh-3rem)] gap-6 overflow-y-auto rounded-3xl p-7 sm:max-w-xl sm:p-8">
      <DialogHeader><DialogTitle className="text-2xl font-semibold tracking-tight">{t("projects.remote.choose")}</DialogTitle><DialogDescription>{t("projects.setup.remote_hint")}</DialogDescription></DialogHeader>
      <div className="overflow-hidden rounded-xl border border-border">
      {source ? <div className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
        <Button variant="ghost" size="icon-sm" aria-label={t("projects.remote.back")} onClick={() => path ? changePath(path.split("/").slice(0, -1).join("/")) : setSource(null)}><ArrowLeft /></Button>
        <span className="min-w-0 truncate" title={`${source.name}/${path}`}>{source.name}{path ? ` / ${path}` : ""}</span>
      </div> : null}
      <div className="min-h-48 max-h-72 overflow-y-auto p-2">
        {!source ? props.sources.map((item) => <Button key={`${item.sourceWorkspaceId}:${item.connectionId}`} variant="ghost" className="h-11 w-full justify-start gap-3 rounded-lg px-3" onClick={() => { setSource(item); changePath(""); }}><Cloud className="text-muted-foreground" /><span className="truncate">{item.name}</span><ChevronRight className="ml-auto text-muted-foreground" /></Button>) : page.isPending ? <div role="status" className="flex min-h-44 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("projects.loading")}</div> : page.error ? <p role="alert" className="p-3 text-sm text-destructive">{page.error.message}</p> : <>
          {page.data.entries.filter((item) => item.kind === "folder").map((item) => <Button key={item.path} variant="ghost" className="h-11 w-full justify-start gap-3 rounded-lg px-3" onClick={() => changePath(item.path)}><FolderIcon className="size-5" /><span className="truncate">{item.name}</span><ChevronRight className="ml-auto text-muted-foreground" /></Button>)}
          {!page.data.entries.some((item) => item.kind === "folder") && <p className="p-3 text-sm text-muted-foreground">{t("projects.remote.no_subfolders")}</p>}
          {page.data.nextCursor && <Button variant="ghost" onClick={() => setCursor(page.data.nextCursor)}>{t("projects.remote.next_page")}</Button>}
        </>}
      </div>
      </div>
      <DialogFooter className="mx-0 mb-0 gap-3 border-0 bg-transparent p-0"><Button variant="ghost" onClick={props.onClose}>{t("projects.cancel")}</Button><Button disabled={!source || !page.data || page.isFetching || Boolean(page.error)} onClick={() => { if (source) props.onSelect({ sourceWorkspaceId: source.sourceWorkspaceId, connectionId: source.connectionId, path, name: path.split("/").at(-1) || source.name, connectionName: source.name }); }}>{t("projects.remote.use_folder")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
