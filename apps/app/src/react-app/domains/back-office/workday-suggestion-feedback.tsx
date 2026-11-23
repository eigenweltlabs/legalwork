import { useLayoutEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ItemDialogContent } from "@/react-app/design-system/item-detail";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatCalendarDay } from "../calendar/calendar-format";

export function WorkdaySuggestionConfirmation({ date, container, trigger, fileHistoryProfileId, onFilesAdded, onStart, onCancel }: {
  fileHistoryProfileId?: string; onFilesAdded: () => void;
  date: string; container: HTMLElement; trigger: HTMLButtonElement; onStart: () => void; onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const desktop = window.__LEGALWORK_ELECTRON__;
  const chooseFolder = desktop?.system?.importWorkdayFileHistory;
  const platform = desktop?.meta?.platform;
  const canScan = fileHistoryProfileId && chooseFolder && (platform === "darwin" || platform === "windows");
  const scan = useMutation({
    mutationFn: async () => {
      if (canScan) return chooseFolder(date, t("timeWorkspace.historyFolder"), fileHistoryProfileId);
    },
    onSuccess: result => { if (result?.imported) onFilesAdded(); },
  });
  const result = scan.data;
  useLayoutEffect(() => {
    // Moving or reopening a pane may replace its original portal target.
    if (!container.isConnected) onCancel();
  }, [container, onCancel]);
  function finish(action: () => void) {
    action();
    // The dialog and its pane's inert state leave in the same render. Restore focus after that commit.
    requestAnimationFrame(() => {
      if (!container.isConnected || container.closest("[hidden]") ||
          (document.activeElement !== document.body && !container.contains(document.activeElement))) return;
      const target = trigger.isConnected && !trigger.disabled ? trigger :
        container.querySelector<HTMLButtonElement>("[data-generation-cancel]") ?? container;
      target.focus({ preventScroll: true });
    });
  }
  return <Dialog open modal={false} onOpenChange={(open, details) => {
    if (open || details.reason === "focus-out") return;
    if ((details.reason === "outside-press" || details.reason === "escape-key") &&
        (details.event.defaultPrevented || !(details.event.target instanceof Node) || !container.contains(details.event.target))) return;
    finish(onCancel);
  }}>
    <ItemDialogContent container={container} data-suggestion-confirmation showCloseButton={false}
      className="max-h-[calc(100%-1rem)] w-[calc(100%-1rem)] overflow-y-auto sm:max-w-sm"
      initialFocus={cancel} finalFocus={false}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = buttons[0], last = buttons[buttons.length - 1];
        const next = event.shiftKey && event.target === first ? last :
          !event.shiftKey && event.target === last ? first : undefined;
        if (next) { event.preventDefault(); next.focus(); }
      }}>
      <DialogHeader className="px-5 py-4">
        <DialogTitle>{t("timeWorkspace.confirmGeneration", { date: formatCalendarDay(date, { dateStyle: "long" }) })}</DialogTitle>
        <DialogDescription>{t("timeWorkspace.confirmGenerationBody")}</DialogDescription>
      </DialogHeader>
      {canScan && <div className="space-y-2 px-5 pb-4">
        <Button variant="outline" size="sm" disabled={scan.isPending} onClick={() => scan.mutate()}>
          {t(scan.isPending ? "timeWorkspace.historyChecking" : "timeWorkspace.historyTitle")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("timeWorkspace.historyHelp")}</p>
        <div role="status" className="empty:hidden text-xs">
          {scan.isError ? t("timeWorkspace.historyError") : result && (result.matched
            ? t(result.matched === 1 ? "timeWorkspace.historySingle" : "timeWorkspace.historyResult", { matched: result.matched, imported: result.imported })
            : t("timeWorkspace.historyEmpty"))}
          {result?.limited && " " + t("timeWorkspace.historyLimited")}
        </div>
      </div>}
      <DialogFooter className="m-0 flex-row justify-end">
        <Button ref={cancel} variant="outline" size="sm" onClick={() => finish(onCancel)}>{t("common.cancel")}</Button>
        <Button disabled={scan.isPending} size="sm" onClick={() => finish(onStart)}>{t("timeWorkspace.createSuggestions")}</Button>
      </DialogFooter>
    </ItemDialogContent>
  </Dialog>;
}
