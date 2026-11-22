import { useLayoutEffect, useRef } from "react";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ItemDialogContent } from "@/react-app/design-system/item-detail";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { WorkdayGenerationProgress } from "@legalwork/types/time-capture";
import { formatCalendarDay } from "../calendar/calendar-format";

const phases = {
  collecting: "timeWorkspace.collectingActivity",
  grouping: "timeWorkspace.groupingActivity",
  wording: "timeWorkspace.preparingDrafts",
  saving: "timeWorkspace.savingDrafts",
} as const;

export function WorkdaySuggestionConfirmation({ date, container, trigger, onStart, onCancel }: {
  date: string; container: HTMLElement; trigger: HTMLButtonElement; onStart: () => void; onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
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
        const next = event.shiftKey && event.target === cancel.current ? submit.current :
          !event.shiftKey && event.target === submit.current ? cancel.current : undefined;
        if (next) { event.preventDefault(); next.focus(); }
      }}>
      <DialogHeader className="px-5 py-4">
        <DialogTitle>{t("timeWorkspace.confirmGeneration", { date: formatCalendarDay(date, { dateStyle: "long" }) })}</DialogTitle>
        <DialogDescription>{t("timeWorkspace.confirmGenerationBody")}</DialogDescription>
      </DialogHeader>
      <DialogFooter className="m-0 flex-row justify-end">
        <Button ref={cancel} variant="outline" size="sm" onClick={() => finish(onCancel)}>{t("common.cancel")}</Button>
        <Button ref={submit} size="sm" onClick={() => finish(onStart)}>{t("timeWorkspace.createSuggestions")}</Button>
      </DialogFooter>
    </ItemDialogContent>
  </Dialog>;
}

export function WorkdaySuggestionFeedback({ running, progress, finished, onCancel }: {
  running: boolean; progress?: WorkdayGenerationProgress | null; finished?: number; onCancel: () => void;
}) {
  if (running) {
    const phase = t(phases[progress?.phase ?? "collecting"]);
    const total = progress?.total;
    return <div className="time-suggestion-feedback">
      <div className="flex items-center justify-between gap-2">
        <span role="status">{phase}{typeof total === "number" && total > 0 && " · " + (progress?.completed ?? 0) + " / " + total}</span>
        <Button data-generation-cancel variant="ghost" size="xs" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
      <progress aria-label={phase} className="time-suggestion-progress" max={total || 1}
        value={total ? progress?.completed : undefined} />
    </div>;
  }
  if (finished !== undefined) return <p className="time-workspace-note" role="status">
    {finished ? t("timeWorkspace.finishedGeneration", { count: finished }) : t("timeWorkspace.finishedEmpty")}
  </p>;
  return null;
}
