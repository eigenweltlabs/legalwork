/** @jsxImportSource react */
import { lazy, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import type { StorageEntry, StorageRoot, StorageWorkingCopy } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { ArtifactPanelView } from "../artifacts/artifact-panel";
import { classifyOpenTarget } from "../artifacts/open-target";
import { PreviewError, PreviewLoading } from "../artifacts/preview";

const ArtifactMarkdownPanel = lazy(() =>
  import("../artifacts/artifact-markdown-panel").then((module) => ({ default: module.ArtifactMarkdownPanel })),
);

type Props = {
  sessionId: string;
  tabId: string;
  client: LegalworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  root: StorageRoot;
  file: StorageEntry;
  onClose: () => void;
};

export function StorageFilePanel(props: Props) {
  const { client, workspaceId, root, file, tabId } = props;
  const copy = useQuery({
    queryKey: ["storage-working-copy", workspaceId, tabId],
    queryFn: () => client.checkoutStorageFile(workspaceId, root.id, file.path),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (copy.isError) return <PreviewError message={copy.error.message} />;
  if (!copy.data) return <PreviewLoading />;
  const working = copy.data;
  const preview = classifyOpenTarget(file.name, "file");
  const Panel = preview === "markdown" ? ArtifactMarkdownPanel : ArtifactPanelView;
  return (
    <Panel
      key={working.localPath}
      {...props}
      target={{
        id: tabId,
        kind: "file",
        value: working.localPath,
        name: file.name,
        preview,
        confidence: 100,
        reason: "storage working copy",
        exists: true,
        size: working.size,
        updatedAt: working.updatedAt,
      }}
      localReadOnly={!working.localWritable}
      saveActions={(persist, busy) => (
        <StorageSaveActions {...props} copy={working} persist={persist} editorBusy={busy} />
      )}
    />
  );
}

function StorageSaveActions({
  client,
  workspaceId,
  root,
  file,
  tabId,
  copy,
  persist,
  editorBusy,
}: Props & {
  copy: StorageWorkingCopy;
  persist: () => Promise<boolean>;
  editorBusy: boolean;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [localDialog, setLocalDialog] = useState(false);
  const [localPath, setLocalPath] = useState(file.name);
  const save = async (destination: "remote" | "local" | "working-copy") => {
    setBusy(true);
    try {
      if (!(await persist())) return;
      if (destination === "remote") {
        const result = await client.saveStorageWorkingCopy(
          workspaceId,
          root.id,
          file.path,
          copy.localPath,
          copy.version,
          copy.contentType,
        );
        queryClient.setQueryData<StorageWorkingCopy>(["storage-working-copy", workspaceId, tabId], (current) =>
          current ? { ...current, version: result.version } : current,
        );
        toast.success(t("storage.saved_remote").replace("{name}", root.name));
      } else if (destination === "local") {
        await client.keepStorageLocalCopy(workspaceId, root.id, copy.localPath, localPath);
        void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
        setLocalDialog(false);
        toast.success(t("storage.saved_local"));
      } else {
        toast.success(t("common.saved"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("artifact.save_failed"));
    } finally {
      setBusy(false);
    }
  };
  const openLatest = async () => {
    setBusy(true);
    try {
      if (copy.localWritable && !(await persist())) return;
      const latest = await client.checkoutStorageFile(workspaceId, root.id, file.path);
      queryClient.removeQueries({ queryKey: ["artifact-panel", workspaceId, tabId], exact: true });
      queryClient.setQueryData(["storage-working-copy", workspaceId, tabId], latest);
      toast.success(t("storage.latest_opened"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("artifact.load_failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex items-center">
        <Button size="sm" className="rounded-r-none" disabled={busy || editorBusy || !copy.localWritable} onClick={() => void save("working-copy")}>
          {busy || editorBusy ? t("common.saving") : t("common.save")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-2" aria-label={t("storage.save_options")} disabled={busy || editorBusy} />}>
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-64">
            <DropdownMenuItem disabled={!copy.writable || !copy.localWritable} onClick={() => void save("remote")}>
              {t("storage.save_remote").replace("{name}", root.name)}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!copy.localWritable} onClick={() => setLocalDialog(true)}>
              {t("storage.save_local")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openLatest()}>
              {t("storage.open_latest").replace("{name}", root.name)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog
        open={localDialog}
        onOpenChange={(open) => {
          if (!busy) setLocalDialog(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("storage.save_local")}</DialogTitle>
            <DialogDescription>{t("storage.local_copy_description")}</DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            {t("storage.local_path")}
            <Input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder={file.name} />
          </label>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setLocalDialog(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy || !localPath.trim()} onClick={() => void save("local")}>
              {busy ? t("common.saving") : t("storage.save_local")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
