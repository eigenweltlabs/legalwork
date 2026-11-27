import { useEffect, useRef, useState } from "react";
import type { SupportTicketChoice, SupportTicketConfirmation } from "@legalwork/types/desktop-ipc";
import { desktopBridge } from "@/app/lib/desktop";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t } from "@/i18n";

export function SupportTicketDialog() {
  const [confirmation, setConfirmation] = useState<SupportTicketConfirmation | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const subscribe = window.__LEGALWORK_ELECTRON__?.onSupportTicketConfirmation;
    if (!subscribe) return;

    let acceptInitial = true;
    const unsubscribe = subscribe(next => {
      acceptInitial = false;
      setConfirmation(next);
    });
    void desktopBridge.supportTicketConfirmationGet().then(initial => {
      if (acceptInitial) setConfirmation(initial);
    }).catch(() => {});
    return () => {
      acceptInitial = false;
      unsubscribe();
    };
  }, []);

  if (!confirmation) return null;

  function reply(id: string, choice: SupportTicketChoice) {
    void desktopBridge.supportTicketConfirmationReply(id, choice).catch(() => {});
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
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelButton}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="outline" onClick={event => {
            if (event.nativeEvent.isTrusted) reply(confirmation.id, "without_logs");
          }}>
            {t("support.ticket_send_without_logs")}
          </AlertDialogAction>
          <AlertDialogAction onClick={event => {
            if (event.nativeEvent.isTrusted) reply(confirmation.id, "with_logs");
          }}>
            {t("support.ticket_send_with_logs")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
