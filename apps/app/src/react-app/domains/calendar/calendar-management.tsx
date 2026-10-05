import { useState } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import type { CalendarItem } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { calendarError, formatCalendarDay, provenanceLabel } from "./calendar-format";
import { CalculationDetails } from "./deadline-dialog";

type CalendarMutationProps = { client: LegalworkServerClient; workspaceId: string; onChanged: () => void };

export function CalendarTrash(props: CalendarMutationProps & { items: CalendarItem[]; onClose: () => void }) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const restore = async (item: CalendarItem) => {
    setRestoring(item.id);
    try {
      await props.client.calendarWrite(props.workspaceId, `/${item.id}/restore`, { revision: item.revision });
      toast.success(t("calendar.restored")); props.onChanged();
    } catch (error) { toast.error(calendarError(error)); } finally { setRestoring(null); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !restoring) props.onClose(); }}><DialogContent className="sm:max-w-lg">
    <DialogHeader><DialogTitle>{t("calendar.trash")}</DialogTitle><DialogDescription>{t("calendar.trash_hint")}</DialogDescription></DialogHeader>
    <div className="max-h-[50vh] overflow-y-auto">
      {props.items.length ? <div className="divide-y divide-border/60">{props.items.map(item => <div key={item.id} className="flex items-center gap-3 py-3">
        <Trash2 className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.title}</p>{item.start && <p className="mt-0.5 text-xs text-muted-foreground">{formatCalendarDay(item.start, { dateStyle: "medium" })}</p>}</div>
        <Button size="sm" variant="ghost" className="shrink-0 text-xs" disabled={Boolean(restoring)} onClick={() => void restore(item)}>{restoring === item.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}{t("calendar.restore")}</Button>
      </div>)}</div> : <Empty variant="ghost" className="py-6"><EmptyHeader><EmptyMedia variant="icon"><Trash2 /></EmptyMedia><EmptyTitle>{t("calendar.trash_empty")}</EmptyTitle><EmptyDescription>{t("calendar.trash_hint")}</EmptyDescription></EmptyHeader></Empty>}
    </div>
    <DialogFooter><Button variant="ghost" onClick={props.onClose} disabled={Boolean(restoring)}>{t("common.close")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function CalendarConflict(props: CalendarMutationProps & { current: CalendarItem; remote: CalendarItem }) {
  const [busy, setBusy] = useState(false);
  const resolve = async (keep: "mine" | "theirs") => {
    setBusy(true);
    try { await props.client.calendarWrite(props.workspaceId, `/${props.current.id}/conflict`, { revision: props.current.revision, keep }); props.onChanged(); }
    catch (error) { toast.error(calendarError(error)); } finally { setBusy(false); }
  };
  return <section role="alert" className="space-y-3 rounded-xl border border-amber-6 bg-amber-2/50 p-4 text-sm">
    <p className="font-medium">{t("calendar.conflict")}</p>
    <div className="grid gap-3 sm:grid-cols-2">{[{ label: t("calendar.mine"), item: props.current }, { label: t("calendar.theirs"), item: props.remote }].map(({ label, item }) => <div key={label} className="space-y-2 rounded-lg border border-border/60 bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p><p className="font-medium">{item.title}</p><p className="text-xs">{item.start && formatCalendarDay(item.start, { dateStyle: "medium" })} · {provenanceLabel(item.provenance.kind)}</p><CalculationDetails item={item} />
    </div>)}</div>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve("mine")}>{t("calendar.keep_mine")}</Button><Button size="sm" disabled={busy} onClick={() => void resolve("theirs")}>{t("calendar.keep_theirs")}</Button></div>
  </section>;
}
