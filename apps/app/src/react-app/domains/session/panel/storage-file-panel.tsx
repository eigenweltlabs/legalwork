/** @jsxImportSource react */
import { useState } from "react";
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
  return (
    <ArtifactPanelView
      key={working.localPath}
      {...props}
      target={{
        id: tabId,
        kind: "file",
        value: working.localPath,
        name: file.name,
        preview: classifyOpenTarget(file.name, "file"),
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
  const save = async (destination: "remote" | "local") => {
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
      } else {
        await client.keepStorageLocalCopy(workspaceId, root.id, copy.localPath, localPath);
        void queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
        setLocalDialog(false);
        toast.success(t("storage.saved_local"));
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
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" disabled={busy || editorBusy} />}>
          {busy || editorBusy ? t("common.saving") : t("storage.save_to")} <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64">
          <DropdownMenuItem disabled={!copy.writable} onClick={() => void save("remote")}>
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
