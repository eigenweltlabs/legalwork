import { useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, FileText, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, X, CircleCheck, ListFilter, Text, ChevronUp, ChevronDown } from "lucide-react";
import type { ReviewCell, ReviewColumn, SavedReview } from "@legalwork/types/reviews";
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
import { ReviewError, ReviewStatus, reviewAnswer } from "./review-ui";

export function ReviewGrid({ review, onSelect, selected, onEdit, onSave, onColumns, onAdd, busy, selectedDocuments, onSelectDocuments }: {
  review: SavedReview; onSelect: (cell: ReviewCell) => void; selected?: ReviewCell;
  onEdit: (column: ReviewColumn) => void; onSave: (columns: ReviewColumn[]) => void;
  onColumns: (columns: ReviewColumn[]) => void; onAdd: () => void; busy: boolean;
  selectedDocuments: string[]; onSelectDocuments: (ids: string[]) => void;
}) {
  const cells = new Map(review.cells.map(cell => [`${cell.documentId}:${cell.columnKey}`, cell]));
  const allSelected = review.documents.length > 0 && review.documents.every(document => selectedDocuments.includes(document.id));
  const someSelected = review.documents.some(document => selectedDocuments.includes(document.id));
  const move = (index: number, direction: number) => {
    const columns = [...review.columns];
    [columns[index], columns[index + direction]] = [columns[index + direction], columns[index]];
    onColumns(columns);
  };
  return <Table containerClassName="h-full overflow-auto" className="w-max min-w-full table-fixed border-separate border-spacing-0 text-xs">
    <TableHeader className="sticky top-0 z-30"><TableRow className="hover:bg-transparent">
      <TableHead className="sticky left-0 z-40 h-10 w-64 min-w-64 max-w-64 border-b border-r bg-background px-3">
        <div className="flex items-center gap-3"><Checkbox aria-label={t("review.select_documents")} checked={allSelected} indeterminate={someSelected && !allSelected} onCheckedChange={checked => onSelectDocuments(checked ? [...new Set([...selectedDocuments, ...review.documents.map(document => document.id)])] : selectedDocuments.filter(id => !review.documents.some(document => document.id === id)))} />
          <span>{t("review.documents")}</span><span className="ml-auto font-normal text-muted-foreground">{review.documents.length}</span>
        </div>
      </TableHead>
      {review.columns.map((column, index) => {
        const Icon = column.kind === "yes_no" ? CircleCheck : column.kind === "classification" ? ListFilter : Text;
        return <TableHead key={column.key} className="group h-10 w-64 min-w-64 max-w-64 border-b border-r border-r-border/40 bg-muted/20 px-3">
          <div className="flex items-center gap-2"><Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t(`review.${column.kind}`)} />
            <span className="min-w-0 flex-1 truncate" title={column.question}>{column.label}</span>
            <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="size-6 shrink-0" aria-label={column.label} disabled={busy} />}><MoreHorizontal className="size-3.5" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => onEdit(column)}><Pencil />{t("review.edit_column")}</DropdownMenuItem><DropdownMenuItem onClick={() => onSave([column])}><BookOpen />{t("review.save_prompt")}</DropdownMenuItem><DropdownMenuSeparator />
                <DropdownMenuItem disabled={index === 0} onClick={() => move(index, -1)}><ArrowLeft />{t("review.move_left")}</DropdownMenuItem><DropdownMenuItem disabled={index === review.columns.length - 1} onClick={() => move(index, 1)}><ArrowRight />{t("review.move_right")}</DropdownMenuItem><DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onColumns(review.columns.filter(item => item.key !== column.key))}><Trash2 />{t("review.remove")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableHead>;
      })}
      <TableHead className="h-10 w-10 border-b bg-muted/20 px-1"><Button variant="ghost" size="icon-sm" aria-label={t("review.add_column")} disabled={busy} onClick={onAdd}><Plus className="size-3.5" /></Button></TableHead>
    </TableRow></TableHeader>
    <TableBody>{review.documents.map(document => <TableRow key={document.id} data-state={selectedDocuments.includes(document.id) ? "selected" : undefined} className="group hover:bg-muted/25">
      <TableCell className="sticky left-0 z-20 w-64 min-w-64 max-w-64 border-b border-r bg-background px-3 py-0 group-data-[state=selected]:bg-muted">
        <div className="flex h-11 items-center gap-3"><Checkbox aria-label={t("review.select_document", { name: document.name })} checked={selectedDocuments.includes(document.id)} onCheckedChange={checked => onSelectDocuments(checked ? [...selectedDocuments, document.id] : selectedDocuments.filter(id => id !== document.id))} />
          <button className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline" title={document.name} onClick={() => requestPanelTab({ id: `review-document:${review.id}:${document.id}`, type: "artifact", label: document.name, value: document.path, preview: classifyOpenTarget(document.path, "file") })}><FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{document.name}</span></button>
        </div>
        {document.status === "preparing" && <p className="pb-2 text-[11px] text-muted-foreground">{t("review.pages", { done: document.completedPages, total: document.pageCount })}</p>}
        {document.error && <p className="pb-2 whitespace-normal text-xs text-warning">{document.error}</p>}
      </TableCell>
      {review.columns.map(column => {
        const cell = cells.get(`${document.id}:${column.key}`); if (!cell) return <TableCell key={column.key} />;
        const active = selected?.documentId === cell.documentId && selected.columnKey === cell.columnKey;
        return <TableCell key={column.key} className={cn("w-64 min-w-64 max-w-64 border-b border-r border-r-border/40 p-0", active && "bg-accent")}><ReviewCellPreview cell={cell} label={`${document.name}: ${column.label}`} onDetails={() => onSelect(cell)} /></TableCell>;
      })}
      <TableCell className="border-b p-0" />
    </TableRow>)}</TableBody>
  </Table>;
}

export function ReviewCellDetail({ client, workspaceId, review, cell, onClose, onRerun, onNavigate, busy }: { client: LegalworkServerClient; workspaceId: string; review: SavedReview; cell: ReviewCell; onClose: () => void; onRerun: () => void; onNavigate: (cell: ReviewCell) => void; busy: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const [opening, setOpening] = useState(false);
  const document = review.documents.find(item => item.id === cell.documentId)!;
  const column = review.columns.find(item => item.key === cell.columnKey)!;
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
    <ReviewStatus status={cell.status} /><ReviewError error={error || (cell.error ? new Error(cell.error) : null)} />
    {result && <div className="mt-5 space-y-5"><div><p className="whitespace-pre-wrap text-base leading-relaxed">{reviewAnswer(result)}</p>{result.reason && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{result.reason}</p>}</div>
      {result.decision && <div className="rounded-xl border p-3"><h4 className="mb-2 text-xs font-medium text-muted-foreground">{t("review.probability")}</h4>{result.decision.type === "noul" ? <p className="text-sm">P({t("review.yes")}) · {(result.decision.noul * 100).toFixed(1)}%</p> : result.decision.type === "choice" ? Object.entries(result.decision.probabilities).map(([label, probability]) => <div key={label} className="flex justify-between gap-4 py-1 text-sm"><span>{label}</span><span className="tabular-nums">{(probability * 100).toFixed(1)}%</span></div>) : null}</div>}
      <section className="space-y-3"><h4 className="text-xs font-medium text-muted-foreground">{t("review.sources")}</h4>{result.citations.length ? result.citations.map((citation, index) => <button key={index} type="button" disabled={opening} onClick={() => void openSource(citation.page, index)} className="w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/30"><p className="text-xs font-medium">{citation.page ? t("review.page", { page: citation.page }) : t("review.unpaginated")}{citation.source === "ocr" ? " · OCR" : ""}</p><blockquote className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{citation.quote}</blockquote></button>) : <p className="text-xs leading-relaxed text-muted-foreground">{t("review.no_citations")}</p>}<Button variant="outline" size="sm" disabled={opening} onClick={() => void openSource()}><FileText className="size-4" />{t("review.open_source")}</Button></section>
      <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">{t("review.provenance")}</summary><div className="mt-3 space-y-3 text-muted-foreground"><p>{result.backend === "systemone" ? "JEV" : "LLM"} · {result.model}</p>{result.confidence && <p>{t("review.confidence")}: {t(`review.${result.confidence}`)}</p>}<p className="font-medium">{t("review.snapshot")}</p><p className="whitespace-pre-wrap leading-relaxed">{result.prompt.question}</p>{result.prompt.options.length > 0 && <p>{result.prompt.options.join(" · ")}</p>}<p>{new Date(result.completedAt).toLocaleString(currentLocale())}</p></div></details>
    </div>}
    <Button variant="outline" size="sm" className="mt-6 w-full" disabled={busy} onClick={onRerun}><RotateCcw className="size-3.5" />{t("review.rerun_cell")}</Button>
  </aside>;
}
