import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, FileText, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, X, CircleCheck, ListFilter, Text, ChevronUp, ChevronDown, CalendarDays, Hash, Banknote, Percent, ListChecks } from "lucide-react";
import type { ReviewCell, ReviewColumn, SavedReview } from "@legalwork/types/reviews";
import { incompatibleJevQuestion } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ReviewCellPreview } from "./review-cell";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { requestPanelTab } from "../session/panel/panel-tab-request";
import { classifyOpenTarget } from "../session/artifacts/open-target";
import { ReviewError, ReviewStatus, ReviewProbabilities, reviewCellError, reviewAnswer, reviewResultReason } from "./review-ui";

export function ReviewGrid({ review, onSelect, selected, onEdit, onSave, onColumns, onAdd, busy, selectedDocuments, onSelectDocuments }: {
  review: SavedReview; onSelect: (cell: ReviewCell) => void; selected?: ReviewCell;
  onEdit: (column: ReviewColumn) => void; onSave: (columns: ReviewColumn[]) => void;
  onColumns: (columns: ReviewColumn[]) => void; onAdd: () => void; busy: boolean;
  selectedDocuments: string[]; onSelectDocuments: (ids: string[]) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const cells = useMemo(() => new Map(review.cells.map(cell => [`${cell.documentId}:${cell.columnKey}`, cell])), [review.cells]);
  const allSelected = review.documents.length > 0 && review.documents.every(document => selectedDocuments.includes(document.id));
  const someSelected = review.documents.some(document => selectedDocuments.includes(document.id));
  const rows = useVirtualizer({ count: review.documents.length, getScrollElement: () => scroll.current, estimateSize: () => 45,
    getItemKey: index => review.documents[index].id, scrollMargin: 56, scrollPaddingStart: 56, overscan: 5, initialRect: { width: 1024, height: 600 } });
  const columns = useVirtualizer({ horizontal: true, count: review.columns.length, getScrollElement: () => scroll.current, estimateSize: () => 256,
    getItemKey: index => review.columns[index].key, paddingStart: 256, paddingEnd: 40, scrollPaddingStart: 256, overscan: 1, initialRect: { width: 1024, height: 600 } });
  const visibleRows = rows.getVirtualItems(), visibleColumns = columns.getVirtualItems();
  const top = visibleRows.length ? visibleRows[0].start - 56 : 0;
  const bottom = visibleRows.length ? rows.getTotalSize() - visibleRows[visibleRows.length - 1].end + 56 : 0;
  const left = visibleColumns.length ? visibleColumns[0].start - 256 : 0;
  const right = visibleColumns.length ? columns.getTotalSize() - visibleColumns[visibleColumns.length - 1].end - 40 : 0;
  const move = (index: number, direction: number) => {
    const next = [...review.columns];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onColumns(next);
  };
  const navigate = (event: KeyboardEvent<HTMLTableElement>) => {
    if (!(event.target instanceof Element)) return;
    const cell = event.target.closest("td[data-review-column]");
    if (!cell || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    let row = Number(cell.getAttribute("data-review-row")), column = Number(cell.getAttribute("data-review-column"));
    if (event.key === "ArrowUp") row--;
    if (event.key === "ArrowDown") row++;
    if (event.key === "ArrowLeft") column--;
    if (event.key === "ArrowRight") column++;
    if (event.key === "Home") { column = 0; if (event.ctrlKey || event.metaKey) row = 0; }
    if (event.key === "End") { column = review.columns.length - 1; if (event.ctrlKey || event.metaKey) row = review.documents.length - 1; }
    row = Math.max(0, Math.min(review.documents.length - 1, row));
    column = Math.max(0, Math.min(review.columns.length - 1, column));
    event.preventDefault();
    rows.scrollToIndex(row, { align: "auto" }); columns.scrollToIndex(column, { align: "auto" });
    requestAnimationFrame(() => requestAnimationFrame(() => scroll.current?.querySelector<HTMLButtonElement>(`td[data-review-row="${row}"][data-review-column="${column}"] button`)?.focus({ preventScroll: true })));
  };
  return <Table containerRef={scroll} containerClassName="h-full overflow-auto" className="table-fixed border-separate border-spacing-0 text-xs" style={{ width: 296 + review.columns.length * 256 }} aria-label={t("review.title")} aria-rowcount={review.documents.length + 1} aria-colcount={review.columns.length + 2} onKeyDown={navigate}>
    <TableHeader className="sticky top-0 z-30 bg-background"><TableRow className="h-14 hover:bg-transparent" aria-rowindex={1}>
      <TableHead className="sticky left-0 z-40 h-14 w-64 min-w-64 max-w-64 border-b border-r bg-background px-3 [&:has([role=checkbox])]:pe-3" aria-colindex={1}>
        <div className="flex items-center gap-3"><Checkbox aria-label={t("review.select_documents")} checked={allSelected} indeterminate={someSelected && !allSelected} onCheckedChange={checked => onSelectDocuments(checked ? [...new Set([...selectedDocuments, ...review.documents.map(document => document.id)])] : selectedDocuments.filter(id => !review.documents.some(document => document.id === id)))} /><span>{t("review.documents")} <span className="font-normal text-muted-foreground">({review.documents.length})</span></span></div>
      </TableHead>
      {left > 0 && <TableHead aria-hidden="true" className="border-b bg-muted/20 p-0" style={{ width: left }} />}
      {visibleColumns.map(item => {
        const column = review.columns[item.index];
        const icons = { yes_no: CircleCheck, classification: ListFilter, text: Text, date: CalendarDays, number: Hash, currency: Banknote, percentage: Percent, multi_select: ListChecks };
        const Icon = icons[column.kind];
        const excluded = review.settings.mode === "jev" && incompatibleJevQuestion(column);
        return <TableHead key={column.key} aria-colindex={item.index + 2} className={cn("group h-14 w-64 min-w-64 max-w-64 border-b border-r border-r-border/40 px-3", excluded ? "bg-muted text-muted-foreground" : "bg-muted/20")}>
          <div className="flex items-center gap-2"><Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t(`review.${column.kind}`)} /><span className="min-w-0 flex-1 truncate" title={column.question}>{column.label}</span>
            <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="size-6 shrink-0" aria-label={column.label} disabled={busy} />}><MoreHorizontal className="size-3.5" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => onEdit(column)}><Pencil />{t("review.edit_column")}</DropdownMenuItem><DropdownMenuItem onClick={() => onSave([column])}><BookOpen />{t("review.save_prompt")}</DropdownMenuItem><DropdownMenuSeparator />
                <DropdownMenuItem disabled={item.index === 0} onClick={() => move(item.index, -1)}><ArrowLeft />{t("review.move_left")}</DropdownMenuItem><DropdownMenuItem disabled={item.index === review.columns.length - 1} onClick={() => move(item.index, 1)}><ArrowRight />{t("review.move_right")}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => onColumns(review.columns.filter(next => next.key !== column.key))}><Trash2 />{t("review.remove")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>{excluded && <p className="pt-1 text-[10px] font-normal" title={t("review.jev_excluded_reason")}>{t("review.jev_excluded")}</p>}
        </TableHead>;
      })}
      {right > 0 && <TableHead aria-hidden="true" className="border-b bg-muted/20 p-0" style={{ width: right }} />}
      <TableHead aria-colindex={review.columns.length + 2} className="h-14 w-10 border-b bg-muted/20 px-1"><Button variant="ghost" size="icon-sm" aria-label={t("review.add_column")} disabled={busy} onClick={onAdd}><Plus className="size-3.5" /></Button></TableHead>
    </TableRow></TableHeader>
    <TableBody>
      {top > 0 && <TableRow aria-hidden="true" className="hover:bg-transparent"><TableCell className="border-0 p-0" colSpan={visibleColumns.length + 2 + Number(left > 0) + Number(right > 0)} style={{ height: top }} /></TableRow>}
      {visibleRows.map(item => {
        const document = review.documents[item.index];
        return <TableRow key={document.id} aria-rowindex={item.index + 2} style={{ height: 45 }} data-state={selectedDocuments.includes(document.id) ? "selected" : undefined} className="group hover:bg-muted/25">
          <TableCell aria-colindex={1} className="sticky left-0 z-20 w-64 min-w-64 max-w-64 border-b border-r bg-background px-3 py-0 group-data-[state=selected]:bg-muted [&:has([role=checkbox])]:pe-3">
            <div className="flex h-11 items-center gap-3"><Checkbox aria-label={t("review.select_document", { name: document.name })} checked={selectedDocuments.includes(document.id)} onCheckedChange={checked => onSelectDocuments(checked ? [...selectedDocuments, document.id] : selectedDocuments.filter(id => id !== document.id))} />
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline" title={document.error || document.name} onClick={() => requestPanelTab({ id: `review-document:${review.id}:${document.id}`, type: "artifact", label: document.name, value: document.path, preview: classifyOpenTarget(document.path, "file") })}><FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block truncate">{document.name}</span>{document.status === "preparing" && <span className="block truncate text-[10px] text-muted-foreground">{t("review.pages", { done: document.completedPages, total: document.pageCount })}</span>}{document.error && <span className="block truncate text-[10px] text-warning">{document.error}</span>}</span></button>
            </div>
          </TableCell>
          {left > 0 && <TableCell aria-hidden="true" className="border-b p-0" style={{ width: left }} />}
          {visibleColumns.map(itemColumn => {
            const column = review.columns[itemColumn.index], cell = cells.get(`${document.id}:${column.key}`);
            const active = selected?.documentId === document.id && selected.columnKey === column.key;
            const excluded = review.settings.mode === "jev" && incompatibleJevQuestion(column);
            return <TableCell key={column.key} aria-colindex={itemColumn.index + 2} data-review-row={item.index} data-review-column={itemColumn.index} className={cn("w-64 min-w-64 max-w-64 border-b border-r border-r-border/40 p-0", excluded ? "bg-muted/60 text-muted-foreground" : active && "bg-accent")}>{cell && <ReviewCellPreview cell={cell} excluded={excluded} label={`${document.name}: ${column.label}`} onDetails={() => onSelect(cell)} />}</TableCell>;
          })}
          {right > 0 && <TableCell aria-hidden="true" className="border-b p-0" style={{ width: right }} />}
          <TableCell aria-colindex={review.columns.length + 2} className="border-b p-0" />
        </TableRow>;
      })}
      {bottom > 0 && <TableRow aria-hidden="true" className="hover:bg-transparent"><TableCell className="border-0 p-0" colSpan={visibleColumns.length + 2 + Number(left > 0) + Number(right > 0)} style={{ height: bottom }} /></TableRow>}
    </TableBody>
  </Table>;
}

export function ReviewCellDetail({ client, workspaceId, review, cell, onClose, onRerun, onNavigate, busy }: { client: LegalworkServerClient; workspaceId: string; review: SavedReview; cell: ReviewCell; onClose: () => void; onRerun: () => void; onNavigate: (cell: ReviewCell) => void; busy: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const [opening, setOpening] = useState(false);
  const document = review.documents.find(item => item.id === cell.documentId)!;
  const column = review.columns.find(item => item.key === cell.columnKey)!;
  const excluded = review.settings.mode === "jev" && incompatibleJevQuestion(column);
  const result = cell.result;
  const rowIndex = review.documents.findIndex(item => item.id === cell.documentId);
  const columnIndex = review.columns.findIndex(item => item.key === cell.columnKey);
  const navigate = (row: number, col: number) => {
    const next = review.cells.find(item => item.documentId === review.documents[row]?.id && item.columnKey === review.columns[col]?.key);
    if (next) onNavigate(next);
  };
  const openSource = async (page?: number | null, citationIndex?: number) => {
    setOpening(true); setError(null);
    try {
      const source = await client.reviewSource(workspaceId, review.id, document.id, result?.sourceHash);
      requestPanelTab({ id: `review-source:${review.id}:${document.id}`, type: "artifact", label: document.name, value: source.path, preview: classifyOpenTarget(source.path, "file"), sourcePage: page ?? undefined, ...(result && page && citationIndex !== undefined ? { reviewCitation: { reviewId: review.id, documentId: document.id, columnKey: column.key, citationIndex, completedAt: result.completedAt } } : {}) });
    } catch (cause) { setError(cause); } finally { setOpening(false); }
  };
  return <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background p-5 xl:w-96"><div className="mb-5 flex items-start gap-3"><div className="min-w-0 flex-1"><h3 className="font-medium">{column.label}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{document.name}</p></div><Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("review.close")}><X className="size-4" /></Button></div>
    <div className="mb-4 flex items-center justify-between border-b pb-3"><div className="flex items-center gap-1"><Button variant="ghost" size="icon-sm" aria-label={t("review.previous_document")} disabled={rowIndex === 0} onClick={() => navigate(rowIndex - 1, columnIndex)}><ChevronUp className="size-3.5" /></Button><span className="text-xs tabular-nums text-muted-foreground">{rowIndex + 1} / {review.documents.length}</span><Button variant="ghost" size="icon-sm" aria-label={t("review.next_document")} disabled={rowIndex === review.documents.length - 1} onClick={() => navigate(rowIndex + 1, columnIndex)}><ChevronDown className="size-3.5" /></Button></div><div className="flex items-center gap-1"><Button variant="ghost" size="icon-sm" aria-label={t("review.previous_column")} disabled={columnIndex === 0} onClick={() => navigate(rowIndex, columnIndex - 1)}><ArrowLeft className="size-3.5" /></Button><Button variant="ghost" size="icon-sm" aria-label={t("review.next_column")} disabled={columnIndex === review.columns.length - 1} onClick={() => navigate(rowIndex, columnIndex + 1)}><ArrowRight className="size-3.5" /></Button></div></div>
    {excluded ? <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">{t("review.jev_excluded_reason")}</p> : <ReviewStatus status={cell.status} />}<ReviewError error={error || (!excluded && reviewCellError(cell))} />
    {result && <div className="mt-5 space-y-5"><div><p className="whitespace-pre-wrap text-base leading-relaxed">{reviewAnswer(result)}</p>{reviewResultReason(result) && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{reviewResultReason(result)}</p>}</div>
      {result.decision && <div className="rounded-xl border p-3"><ReviewProbabilities result={result} /></div>}
      <section className="space-y-3"><h4 className="text-xs font-medium text-muted-foreground">{t("review.sources")}</h4>{result.citations.length ? result.citations.map((citation, index) => <button key={index} type="button" disabled={opening} onClick={() => void openSource(citation.page, index)} className="w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/30"><p className="text-xs font-medium">{citation.page ? t("review.page", { page: citation.page }) : t("review.unpaginated")}{citation.source === "ocr" ? " · OCR" : ""}</p><blockquote className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{citation.quote}</blockquote></button>) : <p className="text-xs leading-relaxed text-muted-foreground">{t("review.no_citations")}</p>}<Button variant="outline" size="sm" disabled={opening} onClick={() => void openSource()}><FileText className="size-4" />{t("review.open_source")}</Button></section>
      <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">{t("review.provenance")}</summary><div className="mt-3 space-y-3 text-muted-foreground"><p>{result.backend === "systemone" ? "JEV" : "LLM"} · {result.model}</p>{result.confidence && <p>{t("review.confidence")}: {t(`review.${result.confidence}`)}</p>}<p className="font-medium">{t("review.snapshot")}</p><p className="whitespace-pre-wrap leading-relaxed">{result.prompt.question}</p>{result.prompt.options.length > 0 && <p>{result.prompt.options.join(" · ")}</p>}<p>{new Date(result.completedAt).toLocaleString(currentLocale())}</p></div></details>
    </div>}
    <Button variant="outline" size="sm" className="mt-6 w-full" disabled={busy || excluded} onClick={onRerun}><RotateCcw className="size-3.5" />{t("review.rerun_cell")}</Button>
  </aside>;
}
