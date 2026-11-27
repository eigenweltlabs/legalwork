import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
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
      <AlertDialogContent initialFocus={cancelButton}
        className="h-[min(16.5rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] grid-rows-[minmax(0,1fr)_auto] gap-4 sm:max-w-sm data-open:zoom-in-100 data-closed:zoom-out-100">
        <AlertDialogCancel ref={cancelButton} aria-label={t("common.cancel")} variant="ghost" size="icon-sm"
          className="absolute end-4 top-4">
          <X aria-hidden />
        </AlertDialogCancel>
        <AlertDialogHeader className="min-h-0 place-items-start content-start overflow-y-auto pe-7 text-start">
          <AlertDialogTitle>{t("support.ticket_confirm_title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("support.ticket_logs")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="grid grid-cols-1">
          <AlertDialogAction variant="outline" onClick={event => {
            if (event.nativeEvent.isTrusted) reply(confirmation.id, "without_logs");
          }}>
            {t("support.ticket_send_without_logs")}
          </AlertDialogAction>
          <AlertDialogAction
            className="bg-[#197245] text-white hover:bg-[#135b36] active:bg-[#104f2f]"
            onClick={event => {
              if (event.nativeEvent.isTrusted) reply(confirmation.id, "with_logs");
            }}>
            {t("support.ticket_send_with_logs")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
