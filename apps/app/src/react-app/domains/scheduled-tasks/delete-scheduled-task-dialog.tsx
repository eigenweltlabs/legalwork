import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { ScheduledTask } from "@legalwork/types/scheduled-tasks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import type { ScheduleClient } from "./scheduled-task-dialog";

export function DeleteScheduledTaskDialog({ client, task, onClose, onDeleted }: {
  client: ScheduleClient; task: ScheduledTask; onClose: () => void; onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true); setError(null);
    try { await client.deleteScheduledTask(task.workspaceId, task.id, task.revision); onDeleted(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("scheduled.delete_failed")); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent><DialogHeader><DialogTitle>{t("scheduled.delete_title")}</DialogTitle><DialogDescription>{t("scheduled.delete_hint")}</DialogDescription></DialogHeader>
      <p className="break-words text-sm font-medium">{task.title}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button autoFocus variant="outline" disabled={busy} onClick={onClose}>{t("scheduled.cancel")}</Button><Button variant="destructive" disabled={busy} aria-busy={busy} onClick={() => void remove()}>{busy && <Loader2 className="size-4 animate-spin" />}{t("scheduled.delete")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
