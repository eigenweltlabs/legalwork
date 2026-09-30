import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/** Paging for a bounded list; hasMore supports server lists with cursor paging. */
export function ListPagination(props: {
  label: string;
  page: number;
  pageSize: number;
  total: number;
  hasMore?: boolean;
  busy?: boolean;
  className?: string;
  onPageChange: (page: number) => void;
}) {
  if (props.total <= props.pageSize && !props.hasMore) return null;
  return (
    <nav aria-label={props.label} className={cn("flex min-h-11 items-center justify-between gap-3 px-3", props.className)}>
      <span role="status" className="text-xs tabular-nums text-muted-foreground">
        {t("common.page_range", {
          from: props.page * props.pageSize + 1,
          to: Math.min((props.page + 1) * props.pageSize, props.total),
          total: `${props.total}${props.hasMore ? "+" : ""}`,
        })}
      </span>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="icon-sm" aria-label={t("common.previous_page")} title={t("common.previous_page")} disabled={props.busy || props.page === 0} onClick={() => props.onPageChange(props.page - 1)}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("common.next_page")} title={t("common.next_page")} disabled={props.busy || (!props.hasMore && (props.page + 1) * props.pageSize >= props.total)} onClick={() => props.onPageChange(props.page + 1)}>
          {props.busy ? <Loader2 className="animate-spin" /> : <ChevronRight />}
        </Button>
      </div>
    </nav>
  );
}
