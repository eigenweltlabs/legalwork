import { useState } from "react";
import { Expand, FileText } from "lucide-react";
import type { ReviewCell } from "@legalwork/types/reviews";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ReviewError, ReviewStatus, reviewAnswer } from "./review-ui";

/** Keep the grid compact; inspecting an answer does not resize its row. */
export function ReviewCellPreview({ cell, label, onDetails }: {
  cell: ReviewCell; label: string; onDetails: () => void;
}) {
  const [open, setOpen] = useState(false);
  const result = cell.result;
  const answer = result ? reviewAnswer(result) : null;
  const typed = result?.prompt.kind !== "text";
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<button type="button" aria-label={label} className="flex h-11 w-full min-w-0 items-center gap-2 px-3 text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />}>
      {result ? <>
        <span className={cn("min-w-0 truncate", typed && "rounded-md bg-muted px-1.5 py-0.5 font-medium", cell.status === "stale" && "text-muted-foreground")}>{answer}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {result.decision?.type === "noul" && <span title={`P(${t("review.yes")})`}>{Math.round(result.decision.noul * 100)}%</span>}
          {!!result.citations.length && <span className="flex items-center gap-1" aria-label={t("review.source_count", { count: result.citations.length })}><FileText className="size-3" />{result.citations.length}</span>}
          {cell.status !== "complete" && <ReviewStatus status={cell.status} />}
        </span>
      </> : <ReviewStatus status={cell.status} />}
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={-2} className="w-80 gap-3 p-3">
      <PopoverTitle className="sr-only">{label}</PopoverTitle>
      <div className="max-h-64 space-y-3 overflow-auto text-sm leading-relaxed">
        {result ? <><p className="whitespace-pre-wrap">{answer}</p>{result.reason && <p className="text-xs text-muted-foreground">{result.reason}</p>}
          {!!result.citations.length && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><FileText className="size-3.5" />{t("review.source_count", { count: result.citations.length })}</p>}</> : <ReviewStatus status={cell.status} />}
        <ReviewError error={cell.error ? new Error(cell.error) : null} />
      </div>
      <div className="flex justify-end border-t pt-2"><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setOpen(false); onDetails(); }}><Expand className="size-3.5" />{t("review.see_details")}</Button></div>
    </PopoverContent>
  </Popover>;
}
