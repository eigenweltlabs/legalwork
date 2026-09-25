import { ArrowDownWideNarrow, ArrowUpWideNarrow, ListFilter, Search, X } from "lucide-react";
import { QueryReviewResultsSchema, type ReviewCell, type SavedReview } from "@legalwork/types/reviews";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { ReviewSelect } from "./review-ui";

export type ReviewFilters = { search: string; column: string; status: string; answer: string; operator: string; value: string; currency: string; sort: string; descending: boolean };
export const emptyReviewFilters: ReviewFilters = { search: "", column: "", status: "all", answer: "", operator: "any", value: "", currency: "", sort: "document", descending: false };
export function reviewFilterQuery(review: SavedReview, filters: ReviewFilters) {
  const column = review.columns.find(column => column.key === filters.column);
  const statuses: Record<string, ReviewCell["status"][]> = { attention: ["blocked", "needs_review", "error", "stale"], complete: ["complete"], needs_review: ["needs_review"], error: ["error"], stale: ["stale"], pending: ["pending", "queued", "running"], absent: ["complete"] };
  const compare = column && ["date", "number", "percentage", "currency"].includes(column.kind) && filters.operator !== "any";
  const valueSort = !!column && filters.sort === "value";
  const needsCurrency = column?.kind === "currency" && (compare || valueSort);
  if (compare && !filters.value.trim()) return { error: "review.filter_value_required" };
  if (needsCurrency && !/^[A-Z]{3}$/.test(filters.currency)) return { error: "review.filter_currency_required" };
  const parsed = QueryReviewResultsSchema.safeParse({
    ...(filters.search.trim() ? { query: filters.search.trim() } : {}),
    ...(column ? { columnKeys: [column.key] } : {}),
    ...(statuses[filters.status] ? { statuses: statuses[filters.status] } : {}),
    ...(filters.status === "absent" ? { evidence: ["absent"] } : {}),
    ...(column && filters.answer ? { values: [filters.answer] } : {}),
    ...(compare ? { valueFilter: { operator: filters.operator, value: column.kind === "date" ? filters.value : Number(filters.value) } } : {}),
    ...(needsCurrency ? { currency: filters.currency } : {}),
    sort: { by: valueSort ? "value" : "document", direction: filters.descending ? "desc" : "asc" },
  });
  return parsed.success ? { input: parsed.data } : { error: "review.filter_invalid" };
}

export function ReviewFilterControls({ review, value, onChange }: { review: SavedReview; value: ReviewFilters; onChange: (value: ReviewFilters) => void }) {
  const update = (change: Partial<ReviewFilters>) => onChange({ ...value, ...change });
  const column = review.columns.find(column => column.key === value.column);
  const typed = column && ["date", "number", "percentage", "currency"].includes(column.kind);
  const active = value.column || value.status !== "all" || value.sort !== "document" || value.descending;
  return <>
    <div className="relative min-w-36 flex-1 sm:max-w-xs"><Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" /><Input className="h-8 pl-8 text-xs" maxLength={300} aria-label={t("review.search_results")} placeholder={t("review.search_results")} value={value.search} onChange={event => update({ search: event.target.value })} /></div>
    <Popover><PopoverTrigger render={<Button variant="outline" size="sm" className="h-8" />}><ListFilter className="size-3.5" />{t("review.filters")}{active && <span className="size-1.5 rounded-full bg-foreground" />}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-4 p-4"><PopoverTitle>{t("review.filters")}</PopoverTitle>
        <Field className="gap-1.5"><FieldLabel>{t("review.filter_column")}</FieldLabel><ReviewSelect value={value.column || "all"} label={t("review.filter_column")} onChange={column => update({ column: column === "all" ? "" : column, answer: "", operator: "any", value: "", currency: "", sort: "document" })} options={[{ value: "all", label: t("review.all_columns") }, ...review.columns.map(column => ({ value: column.key, label: column.label }))]} /></Field>
        {(column?.kind === "classification" || column?.kind === "yes_no") && <Field className="gap-1.5"><FieldLabel>{t("review.filter_answer")}</FieldLabel><ReviewSelect value={value.answer ? `answer:${value.answer}` : "all"} label={t("review.filter_answer")} onChange={answer => update({ answer: answer === "all" ? "" : answer.slice(7) })} options={[{ value: "all", label: t("review.all_answers") }, ...(column.kind === "yes_no" ? ["Yes", "No"] : column.options).map(option => ({ value: `answer:${option}`, label: option }))]} /></Field>}
        {typed && <Field className="gap-1.5"><FieldLabel>{t("review.filter_value")}</FieldLabel><ReviewSelect value={value.operator} label={t("review.filter_comparison")} onChange={operator => update({ operator })} options={["any", "eq", "gt", "gte", "lt", "lte"].map(operator => ({ value: operator, label: t(`review.compare_${operator}`) }))} />{value.operator !== "any" && <Input type={column.kind === "date" ? "date" : "number"} step="any" value={value.value} aria-label={t("review.filter_value")} onChange={event => update({ value: event.target.value })} />}</Field>}
        {column?.kind === "currency" && (value.operator !== "any" || value.sort === "value") && <Field className="gap-1.5"><FieldLabel>{t("review.filter_currency")}</FieldLabel><Input placeholder="EUR" maxLength={3} value={value.currency} aria-label={t("review.filter_currency")} onChange={event => update({ currency: event.target.value.toUpperCase() })} /></Field>}
        <Field className="gap-1.5"><FieldLabel>{t("review.status")}</FieldLabel><ReviewSelect value={value.status} label={t("review.status")} onChange={status => update({ status })} options={[{ value: "all", label: t("review.all_answers") }, { value: "attention", label: t("review.attention_only") }, ...["complete", "needs_review", "error", "stale", "pending", "absent"].map(status => ({ value: status, label: t(`review.${status}`) }))]} /></Field>
        <Field className="gap-1.5"><FieldLabel>{t("review.sort_by")}</FieldLabel><div className="flex gap-2"><div className="min-w-0 flex-1"><ReviewSelect value={column ? value.sort : "document"} label={t("review.sort_by")} onChange={sort => update({ sort })} options={[{ value: "document", label: t("review.documents") }, ...(column ? [{ value: "value", label: column.label }] : [])]} /></div><Button variant="outline" size="icon" aria-label={t(value.descending ? "review.sort_desc" : "review.sort_asc")} onClick={() => update({ descending: !value.descending })}>{value.descending ? <ArrowDownWideNarrow className="size-4" /> : <ArrowUpWideNarrow className="size-4" />}</Button></div></Field>
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...emptyReviewFilters, search: value.search })}>{t("review.reset_filters")}</Button>
      </PopoverContent>
    </Popover>
    {(active || value.search) && <Button variant="ghost" size="icon-sm" aria-label={t("review.reset_filters")} onClick={() => onChange(emptyReviewFilters)}><X className="size-3.5" /></Button>}
  </>;
}
