import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export const WORKFLOWS_PER_PAGE = 25;

export function WorkflowPagination({ page, total, onPageChange }: {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= WORKFLOWS_PER_PAGE) return null;
  return <nav aria-label={t("workflows.pagination")} className="flex h-11 shrink-0 items-center justify-between gap-2 border-t border-border px-3">
    <span className="text-[11px] tabular-nums text-muted-foreground" role="status">
      {t("workflows.page_range", { from: page * WORKFLOWS_PER_PAGE + 1, to: Math.min((page + 1) * WORKFLOWS_PER_PAGE, total), total })}
    </span>
    <div className="flex shrink-0 gap-1">
      <Button variant="ghost" size="icon-sm" aria-label={t("common.previous_page")} title={t("common.previous_page")} disabled={page === 0} onClick={() => onPageChange(page - 1)}><ChevronLeft /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={t("common.next_page")} title={t("common.next_page")} disabled={(page + 1) * WORKFLOWS_PER_PAGE >= total} onClick={() => onPageChange(page + 1)}><ChevronRight /></Button>
    </div>
  </nav>;
}
