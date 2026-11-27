import { useEffect, useId, useRef, useState } from "react";
import type { SupportTicketChoice, SupportTicketConfirmation } from "@legalwork/types/desktop-ipc";
import { desktopBridge } from "@/app/lib/desktop";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";

export function SupportTicketDialog() {
  const [confirmation, setConfirmation] = useState<SupportTicketConfirmation | null>(null);
  const [days, setDays] = useState("");
  const daysId = useId();
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const subscribe = window.__LEGALWORK_ELECTRON__?.onSupportTicketConfirmation;
    if (!subscribe) return;

    let acceptInitial = true;
    function show(next: SupportTicketConfirmation | null) {
      setConfirmation(next);
      setDays(next ? String(next.logDays) : "");
    }
    const unsubscribe = subscribe(next => {
      acceptInitial = false;
      show(next);
    });
    void desktopBridge.supportTicketConfirmationGet().then(initial => {
      if (acceptInitial) show(initial);
    }).catch(() => {});
    return () => {
      acceptInitial = false;
      unsubscribe();
    };
  }, []);

  if (!confirmation) return null;

  const logDays = Number(days);
  const validDays = Number.isInteger(logDays) && logDays >= 1 && logDays <= 365;
  function reply(id: string, choice: SupportTicketChoice) {
    void desktopBridge.supportTicketConfirmationReply(id, choice, choice === "with_logs" ? logDays : undefined).catch(() => {});
  }

  return (
    <AlertDialog open onOpenChange={open => { if (!open) reply(confirmation.id, "cancel"); }}>
      <AlertDialogContent initialFocus={cancelButton} className="w-[calc(100%-2rem)] gap-4 sm:max-w-lg">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>{t("support.ticket_confirm_title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("support.ticket_identity", { email: confirmation.email })}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">{t("support.ticket_description")}</p>
          <p className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm">
            {confirmation.description}
          </p>
          <p className="text-sm text-muted-foreground">{t("support.ticket_logs")}</p>
          <div className="flex items-center gap-3">
            <label htmlFor={daysId} className="text-sm font-medium">{t("support.ticket_log_days")}</label>
            <Input id={daysId} type="number" min={1} max={365} step={1} className="w-20" value={days}
              aria-invalid={!validDays} aria-describedby={!validDays ? `${daysId}-error` : undefined}
              onChange={event => setDays(event.target.value)} />
          </div>
          {!validDays && <p id={`${daysId}-error`} className="text-sm text-destructive">{t("updates.technical_diagnostics_days_invalid")}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelButton}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="outline" onClick={event => {
            if (event.nativeEvent.isTrusted) reply(confirmation.id, "without_logs");
          }}>
            {t("support.ticket_send_without_logs")}
          </AlertDialogAction>
          <AlertDialogAction disabled={!validDays} onClick={event => {
            if (event.nativeEvent.isTrusted) reply(confirmation.id, "with_logs");
          }}>
            {t("support.ticket_send_with_logs")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
