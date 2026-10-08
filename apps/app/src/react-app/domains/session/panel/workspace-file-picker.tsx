import { useState } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { t } from "@/i18n";
import { WorkspaceFilesPanel } from "./workspace-files-panel";
import { LegalMemoryFilesPanel } from "./legalmemory-files-panel";
import { PanelTabDestinationProvider } from "./panel-tab-destination";
import type { PanelTab } from "./panel-tab-store";
import type { readViewerFileDrop } from "./viewer-file-drop";

/** Browse existing sources; only an explicit Upload action opens the OS picker. */
export function WorkspaceFilePicker(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  projectId: string;
  paneId: string;
  workspaceRoot: string;
  isRemoteWorkspace: boolean;
  onClose: () => void;
  onOpen: (drop: ReturnType<typeof readViewerFileDrop>) => void;
  onOpenTab: (tab: PanelTab) => void;
}) {
  const [source, setSource] = useState<unknown>("files");
  const empty = { projects: [], workspace: null, storage: null, memory: null, files: [] };
  return <Dialog open onOpenChange={open => { if (!open) props.onClose(); }}>
    <DialogContent className="flex h-[min(36rem,85dvh)] flex-col gap-4 sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t("side_panel.choose_file")}</DialogTitle>
        <DialogDescription>{t("side_panel.choose_file_description")}</DialogDescription>
      </DialogHeader>
      <PanelTabDestinationProvider destination={{ kind: "workspace", workspaceId: props.projectId, paneId: props.paneId }} onOpen={props.onOpenTab}>
        <Tabs value={source} onValueChange={setSource} className="min-h-0 flex-1">
          <TabsList><TabsTrigger value="files">{t("session.workspace_files")}</TabsTrigger><TabsTrigger value="memory">{t("sidebar.memory_drive")}</TabsTrigger></TabsList>
          <TabsContent value="files" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
            <WorkspaceFilesPanel client={props.client} workspaceId={props.workspaceId} workspaceRoot={props.workspaceRoot} isRemoteWorkspace={props.isRemoteWorkspace} active={source === "files"} searchable
              onOpenFile={entry => props.onOpen({ ...empty, workspace: { workspaceId: props.workspaceId, path: entry.path, name: entry.name } })} />
          </TabsContent>
          <TabsContent value="memory" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
            <LegalMemoryFilesPanel client={props.client} workspaceId={props.workspaceId}
              onOpenFile={file => props.onOpen({ ...empty, memory: file })}
              onOpenStorageFile={(root, file) => props.onOpen({ ...empty, storage: { connectionId: root.id, connectionName: root.name, path: file.path, name: file.name } })} />
          </TabsContent>
        </Tabs>
      </PanelTabDestinationProvider>
    </DialogContent>
  </Dialog>;
}
