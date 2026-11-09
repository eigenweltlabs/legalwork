import { useId, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { redactTokenLikeText } from "@/app/utils";

export type ReconnectNoticeProps = {
  error: string;
  pending: boolean;
  onRetry: () => void | Promise<void>;
};

export function ReconnectNotice({ error, pending, onRetry }: ReconnectNoticeProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  return <section role={pending ? "status" : "alert"} className="mx-6 mt-4 shrink-0 rounded-xl border border-red-7/35 bg-red-1/40 px-4 py-3 text-sm">
    <div className="flex flex-wrap items-center gap-3">
      <CircleAlert aria-hidden className="size-4 shrink-0 text-red-11" />
      <p className="min-w-0 flex-1 font-medium text-red-11">{t(pending ? "session.reconnect_pending" : "session.reconnect_failed")}</p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={pending} onClick={() => void onRetry()}>
          {pending && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
          {t(pending ? "session.reconnect_pending" : "session.reconnect_retry")}
        </Button>
        <Button variant="ghost" size="sm" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(open => !open)}>
          {t(detailsOpen ? "session.reconnect_hide_details" : "session.reconnect_show_details")}
        </Button>
      </div>
    </div>
    {detailsOpen && <pre id={detailsId} className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-3 font-mono text-xs text-muted-foreground">{redactTokenLikeText(error)}</pre>}
  </section>;
}
