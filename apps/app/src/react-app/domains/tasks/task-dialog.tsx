import { lazy, Suspense, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
    <DialogContent ref={contentRef} initialFocus={contentRef} className={cn("flex h-[min(760px,85dvh)] flex-col gap-0 p-0 sm:max-w-2xl", attachment && "sm:max-w-5xl")}>
      <DialogTitle className="sr-only">{attachment?.label ?? t("calendar.task")}</DialogTitle>
      <div className={cn("min-h-0 flex-1", attachment && "hidden")}>
        <TaskContent {...props} inDialog onOpenAttachment={setAttachment} />
      </div>
      {attachment?.value && <>
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4 pe-14">
          <Button variant="ghost" size="icon-sm" aria-label={t("calendar.task")} onClick={() => setAttachment(null)}><ArrowLeft /></Button>
          <span className="truncate text-sm font-medium">{attachment.label}</span>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}>
            <AttachmentViewer client={props.client} workspaceId={props.workspaceId} workspaceRoot="" sessionId={`task:${props.taskId}`} localReadOnly
              target={{ id: attachment.id, kind: "file", value: attachment.value, name: attachment.label, preview: attachment.preview ?? "file", confidence: 100, reason: "task attachment", exists: true, size: attachment.size, updatedAt: attachment.updatedAt }}
              onClose={() => setAttachment(null)} />
          </Suspense>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
