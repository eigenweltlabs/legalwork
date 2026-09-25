import { useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, FileText, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { ReviewCell, ReviewColumn, SavedReview } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { requestPanelTab } from "../session/panel/panel-tab-request";
import { classifyOpenTarget } from "../session/artifacts/open-target";
import { ReviewError, ReviewStatus, reviewAnswer } from "./review-ui";

export function ReviewGrid({ review, onSelect, selected, onEdit, onSave, onColumns, onAdd, busy }: {
  review: SavedReview; onSelect: (cell: ReviewCell) => void; selected?: ReviewCell; onEdit: (column: ReviewColumn) => void; onSave: (columns: ReviewColumn[]) => void; onColumns: (columns: ReviewColumn[]) => void; onAdd: () => void; busy: boolean;
}) {
  const cells = new Map(review.cells.map(cell => [`${cell.documentId}:${cell.columnKey}`, cell]));
  const move = (index: number, direction: number) => { const columns = [...review.columns]; [columns[index], columns[index + direction]] = [columns[index + direction], columns[index]]; onColumns(columns); };
  return <Table className="border-separate border-spacing-0 text-sm"><TableHeader><TableRow className="hover:bg-transparent">
    <TableHead className="sticky left-0 z-20 min-w-56 max-w-72 border-b border-r bg-background px-4 py-4 font-medium">{t("review.documents")} <span className="ml-2 text-xs font-normal text-muted-foreground">{review.documents.length}</span></TableHead>
    {review.columns.map((column, index) => <TableHead key={column.key} className="min-w-60 max-w-72 border-b border-r bg-muted/20 px-4 py-3"><div className="flex items-center gap-2"><span className="flex-1 truncate font-medium text-foreground" title={column.question}>{column.label}</span><DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={column.label} disabled={busy} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => onEdit(column)}><Pencil />{t("review.edit_column")}</DropdownMenuItem><DropdownMenuItem onClick={() => onSave([column])}><BookOpen />{t("review.save_prompt")}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem disabled={index === 0} onClick={() => move(index, -1)}><ArrowLeft />{t("review.move_left")}</DropdownMenuItem><DropdownMenuItem disabled={index === review.columns.length - 1} onClick={() => move(index, 1)}><ArrowRight />{t("review.move_right")}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => onColumns(review.columns.filter(item => item.key !== column.key))}><Trash2 />{t("review.remove")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div><span className="text-xs font-normal text-muted-foreground">{t(`review.${column.kind}`)} · {review.settings.mode === "llm" || column.kind === "text" ? "LLM" : "JEV"}</span></TableHead>)}
    <TableHead className="border-b bg-muted/20 px-2"><Button variant="ghost" size="icon-sm" aria-label={t("review.add_column")} disabled={busy} onClick={onAdd}><Plus className="size-4" /></Button></TableHead>
  </TableRow></TableHeader><TableBody>{review.documents.map(document => <TableRow key={document.id} className="hover:bg-transparent"><TableCell className="sticky left-0 z-10 max-w-72 border-b border-r bg-background px-4 py-4 align-top"><div className="flex gap-2.5"><FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="truncate font-medium" title={document.name}>{document.name}</p>{document.status === "preparing" && <p className="mt-1 text-xs text-muted-foreground">{t("review.pages", { done: document.completedPages, total: document.pageCount })}</p>}{document.error && <p className="mt-1 whitespace-normal text-xs text-warning">{document.error}</p>}</div></div></TableCell>
    {review.columns.map(column => { const cell = cells.get(`${document.id}:${column.key}`); if (!cell) return <TableCell key={column.key} />; const active = selected?.documentId === cell.documentId && selected.columnKey === cell.columnKey;
      return <TableCell key={column.key} className={cn("border-b border-r p-0 align-top", active && "bg-accent/70")}><button type="button" onClick={() => onSelect(cell)} className="min-h-20 w-full max-w-72 space-y-2 px-4 py-4 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-label={`${document.name}: ${column.label}`}><div className={cn("line-clamp-4 whitespace-normal leading-relaxed", cell.status === "stale" && "text-muted-foreground")}>{cell.result ? reviewAnswer(cell.result) : <ReviewStatus status={cell.status} />}</div>{cell.result && cell.status !== "complete" && <ReviewStatus status={cell.status} />}{cell.result?.decision?.type === "noul" && <span className="block text-xs text-muted-foreground">P({t("review.yes")}) {Math.round(cell.result.decision.noul * 100)}%</span>}{!!cell.result?.citations.length && <span className="block text-xs text-muted-foreground">{t("review.source_count", { count: cell.result.citations.length })}</span>}</button></TableCell>;
    })}<TableCell className="border-b" />
  </TableRow>)}</TableBody></Table>;
}

export function ReviewCellDetail({ client, workspaceId, review, cell, onClose, onRerun, busy }: { client: LegalworkServerClient; workspaceId: string; review: SavedReview; cell: ReviewCell; onClose: () => void; onRerun: () => void; busy: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const [opening, setOpening] = useState(false);
  const document = review.documents.find(item => item.id === cell.documentId)!;
  const column = review.columns.find(item => item.key === cell.columnKey)!;
  const result = cell.result;
  const openSource = async (page?: number | null, citationIndex?: number) => {
    setOpening(true); setError(null);
    try {
      const source = await client.reviewSource(workspaceId, review.id, document.id, result?.sourceHash);
      requestPanelTab({ id: `review-source:${review.id}:${document.id}`, type: "artifact", label: document.name, value: source.path, preview: classifyOpenTarget(source.path, "file"), sourcePage: page ?? undefined, ...(result && page && citationIndex !== undefined ? { reviewCitation: { reviewId: review.id, documentId: document.id, columnKey: column.key, citationIndex, completedAt: result.completedAt } } : {}) });
    } catch (cause) { setError(cause); } finally { setOpening(false); }
  };
  return <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background p-5 xl:w-96"><div className="mb-5 flex items-start gap-3"><div className="min-w-0 flex-1"><h3 className="font-medium">{column.label}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{document.name}</p></div><Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("review.close")}><X className="size-4" /></Button></div>
    <ReviewStatus status={cell.status} /><ReviewError error={error || (cell.error ? new Error(cell.error) : null)} />
    {result && <div className="mt-5 space-y-5"><div><p className="whitespace-pre-wrap text-base leading-relaxed">{reviewAnswer(result)}</p>{result.reason && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{result.reason}</p>}</div>
      {result.decision && <div className="rounded-xl border p-3"><h4 className="mb-2 text-xs font-medium text-muted-foreground">{t("review.probability")}</h4>{result.decision.type === "noul" ? <p className="text-sm">P({t("review.yes")}) · {(result.decision.noul * 100).toFixed(1)}%</p> : result.decision.type === "choice" ? Object.entries(result.decision.probabilities).map(([label, probability]) => <div key={label} className="flex justify-between gap-4 py-1 text-sm"><span>{label}</span><span className="tabular-nums">{(probability * 100).toFixed(1)}%</span></div>) : null}</div>}
      <section className="space-y-3"><h4 className="text-xs font-medium text-muted-foreground">{t("review.sources")}</h4>{result.citations.length ? result.citations.map((citation, index) => <button key={index} type="button" disabled={opening} onClick={() => void openSource(citation.page, index)} className="w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/30"><p className="text-xs font-medium">{citation.page ? t("review.page", { page: citation.page }) : t("review.unpaginated")}{citation.source === "ocr" ? " · OCR" : ""}</p><blockquote className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{citation.quote}</blockquote></button>) : <p className="text-xs leading-relaxed text-muted-foreground">{t("review.no_citations")}</p>}<Button variant="outline" size="sm" disabled={opening} onClick={() => void openSource()}><FileText className="size-4" />{t("review.open_source")}</Button></section>
      <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">{t("review.provenance")}</summary><div className="mt-3 space-y-3 text-muted-foreground"><p>{result.backend === "systemone" ? "JEV" : "LLM"} · {result.model}</p>{result.confidence && <p>{t("review.confidence")}: {t(`review.${result.confidence}`)}</p>}<p className="font-medium">{t("review.snapshot")}</p><p className="whitespace-pre-wrap leading-relaxed">{result.prompt.question}</p>{result.prompt.options.length > 0 && <p>{result.prompt.options.join(" · ")}</p>}<p>{new Date(result.completedAt).toLocaleString(currentLocale())}</p></div></details>
    </div>}
    <Button variant="outline" size="sm" className="mt-6 w-full" disabled={busy} onClick={onRerun}><RotateCcw className="size-3.5" />{t("review.rerun_cell")}</Button>
  </aside>;
}
