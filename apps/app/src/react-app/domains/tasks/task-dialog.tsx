import { lazy, Suspense, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { ItemDialogContent } from "@/react-app/design-system/item-detail";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ArtifactPanelTab } from "../session/panel/panel-tab-store";
import { TaskContent } from "./task-panel";

const AttachmentViewer = lazy(() => import("../session/artifacts/artifact-panel").then(module => ({ default: module.ArtifactPanelView })));

export function TaskDialog(props: {
  taskId: string;
  client: LegalworkServerClient;
  workspaceId: string;
  projects?: { id: string; name: string }[];
  onClose: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [attachment, setAttachment] = useState<ArtifactPanelTab | null>(null);
  return <Dialog open onOpenChange={open => { if (!open) props.onClose(); }}>
    <ItemDialogContent ref={contentRef} initialFocus={contentRef} showCloseButton={!attachment} className={cn("h-[min(560px,85dvh)]", attachment && "h-[min(760px,85dvh)] sm:max-w-5xl")}>
      <DialogTitle className="sr-only">{attachment?.label ?? t("calendar.task")}</DialogTitle>
      <div className={cn("min-h-0 flex-1", attachment && "hidden")}>
        <TaskContent {...props} inDialog onOpenAttachment={setAttachment} />
      </div>
      {attachment?.value && <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}>
            <AttachmentViewer client={props.client} workspaceId={props.workspaceId} workspaceRoot="" sessionId={`task:${props.taskId}`} localReadOnly
              target={{ id: attachment.id, kind: "file", value: attachment.value, name: attachment.label, preview: attachment.preview ?? "file", confidence: 100, reason: "task attachment", exists: true, size: attachment.size, updatedAt: attachment.updatedAt }}
              onClose={() => setAttachment(null)} />
          </Suspense>
      </div>}
    </ItemDialogContent>
  </Dialog>;
}
