import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, BookOpen, Download, FileText, MoreHorizontal, Search, Play, Plus, RotateCcw, Settings2, Square, Table2, X } from "lucide-react";
import type { ReviewCell, ReviewColumn, RunReview, SavedReview } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { currentLocale, t } from "@/i18n";
import { ReviewDocumentsDialog } from "./review-documents";
import { ReviewSettingsDialog } from "./review-settings";
import { ReviewColumnDialog, ReviewLibraryDialog, SaveReviewPromptDialog } from "./review-columns";
import { ReviewGrid, ReviewCellDetail } from "./review-grid";
import { ReviewError, ReviewStatus, ReviewSelect, reviewAnswer, reviewKey } from "./review-ui";

type DialogState = { type: "documents" | "settings" | "library" } | { type: "column"; column?: ReviewColumn } | { type: "save"; columns: ReviewColumn[] } | null;
function exportReview(review: SavedReview) {
  // Neutralize spreadsheet formulas in user/document/model-controlled values.
  const csv = (value: string) => `"${(/^[=+@\-\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  const rows = [[t("review.documents"), ...review.columns.map(column => column.label)], ...review.documents.map(document => [document.name, ...review.columns.map(column => {
    const cell = review.cells.find(item => item.documentId === document.id && item.columnKey === column.key);
    return cell?.result ? `${reviewAnswer(cell.result)}${cell.result.decision ? ` [${cell.result.decision.type === "noul" ? `P(${t("review.yes")})=${(cell.result.decision.noul * 100).toFixed(1)}%` : cell.result.decision.type === "choice" ? Object.entries(cell.result.decision.probabilities).map(([label, value]) => `${label}=${(value * 100).toFixed(1)}%`).join("; ") : ""}]` : ""}${cell.status === "complete" ? "" : ` (${t(`review.${cell.status}`)})`}` : cell ? t(`review.${cell.status}`) : "";
  })])];
  const url = URL.createObjectURL(new Blob(["\uFEFF", rows.map(row => row.map(csv).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${review.name.replace(/[/\\:*?"<>|]/g, "-")}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ProjectReviews({ client, workspaceId, projectName }: { client: LegalworkServerClient; workspaceId: string; projectName: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewId = searchParams.get("review");
  const queryClient = useQueryClient();
  const [documentSearch, setDocumentSearch] = useState("");
  const [answerFilter, setAnswerFilter] = useState("all");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [selectedDocuments, setSelectedDocuments] = useState<string[]>([]);
  const [selected, setSelected] = useState<Pick<ReviewCell, "documentId" | "columnKey"> | null>(null);
  const listing = useQuery({ queryKey: reviewKey(workspaceId), queryFn: () => client.listReviews(workspaceId), refetchInterval: query => query.state.data?.reviews.some(review => review.status === "running") ? 3000 : false });
  const detail = useQuery({ queryKey: reviewKey(workspaceId, reviewId ?? "none"), queryFn: () => client.getReview(workspaceId, reviewId!), enabled: !!reviewId, refetchInterval: query => query.state.data?.status === "running" ? 1000 : 5000 });
  const review = detail.data;
  const running = review?.status === "running";
  const openReview = (id?: string) => { setSelected(null); setSelectedDocuments([]); setDocumentSearch(""); setAnswerFilter("all"); setSearchParams(id ? { review: id } : {}); };
  const refreshed = async (value: SavedReview) => { queryClient.setQueryData(reviewKey(workspaceId, value.id), value); await queryClient.invalidateQueries({ queryKey: reviewKey(workspaceId) }); };
  const change = useMutation({ mutationFn: async (action: { type: "columns"; columns: ReviewColumn[] } | { type: "run"; options?: Partial<RunReview> } | { type: "stop" }) => {
    if (!review) throw new Error(t("review.failed"));
    if (action.type === "columns") return client.editReview(workspaceId, review.id, { revision: review.revision, columns: action.columns });
    if (action.type === "stop") return client.cancelReview(workspaceId, review.id);
    return client.startReview(workspaceId, review.id, { revision: review.revision, rerun: false, reprocess: false, ...action.options });
  }, onSuccess: refreshed, onError: () => { void queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); } });
  const activeCell = review?.cells.find(cell => cell.documentId === selected?.documentId && cell.columnKey === selected.columnKey);
  const done = review?.cells.filter(cell => ["complete", "needs_review", "error"].includes(cell.status)).length ?? 0;
  const busy = !!running || change.isPending;
  const pickedDocuments = selectedDocuments.filter(id => review?.documents.some(document => document.id === id));
  const visibleReview = review && { ...review, documents: review.documents.filter(document => document.name.toLocaleLowerCase().includes(documentSearch.toLocaleLowerCase()) && (answerFilter === "all" || review.cells.some(cell => cell.documentId === document.id && ["needs_review", "error", "stale"].includes(cell.status)))) };
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
    <header className="shrink-0 px-6 pb-4 pt-5 lg:px-8">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">{reviewId ? <Button variant="ghost" size="sm" className="-ml-2 h-6 text-xs" onClick={() => openReview()}><ArrowLeft className="size-3.5" />{t("review.back")}</Button> : <span>{projectName}</span>}</div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-xl font-semibold tracking-tight">{reviewId ? review?.name ?? t("review.loading") : t("review.title")}</h1>{!reviewId && <p className="mt-1.5 text-sm text-muted-foreground">{t("review.subtitle")}</p>}</div>
        <div className="flex items-center gap-2">{!reviewId ? <>
          <Button variant="outline" onClick={() => setDialog({ type: "library" })}><BookOpen className="size-4" />{t("review.library")}</Button><Button variant="ghost" size="icon" aria-label={t("review.settings")} onClick={() => setDialog({ type: "settings" })}><Settings2 className="size-4" /></Button><Button onClick={() => setDialog({ type: "documents" })}><Plus className="size-4" />{t("review.new")}</Button>
        </> : review && <>
          <Button variant="ghost" size="sm" disabled={busy} aria-label={t("review.settings")} onClick={() => setDialog({ type: "settings" })}><Settings2 className="size-3.5" />{t(`review.${review.settings.mode}`)}</Button>
          {running ? <Button size="sm" variant="outline" disabled={change.isPending} onClick={() => change.mutate({ type: "stop" })}><Square className="size-3.5" />{t("review.stop")}</Button> : <Button size="sm" disabled={!review.columns.length || change.isPending} onClick={() => change.mutate({ type: "run", options: { rerun: review.status === "complete" } })}><Play className="size-3.5" />{t(review.status === "complete" ? "review.rerun_all" : review.runId ? "review.resume" : "review.run")}</Button>}
          <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("review.actions")} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end">
            <DropdownMenuItem disabled={busy} onClick={() => setDialog({ type: "documents" })}><FileText />{t("review.edit_documents")}</DropdownMenuItem><DropdownMenuItem disabled={busy || !review.columns.length} onClick={() => setDialog({ type: "save", columns: review.columns })}><BookOpen />{t("review.save_set")}</DropdownMenuItem><DropdownMenuItem disabled={busy || !review.columns.length} onClick={() => change.mutate({ type: "run", options: { rerun: true } })}><RotateCcw />{t("review.rerun_all")}</DropdownMenuItem><DropdownMenuItem disabled={!review.cells.some(cell => cell.result)} onClick={() => exportReview(review)}><Download />{t("review.export")}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
        </>}</div>
      </div>
    </header>
    <div className="px-6 lg:px-8"><ReviewError error={(reviewId ? detail.error : listing.error) || change.error} /></div>
    {!reviewId ? <div className="min-h-0 flex-1 overflow-auto px-6 pb-8 lg:px-8">{listing.isPending ? <p className="py-8 text-muted-foreground">{t("review.loading")}</p> : !listing.data?.reviews.length ? <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center"><div className="mb-5 rounded-2xl border bg-muted/20 p-4"><Table2 className="size-7 text-muted-foreground" strokeWidth={1.4} /></div><h2 className="text-lg font-medium tracking-tight">{t("review.empty")}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("review.empty_body")}</p><Button className="mt-6" onClick={() => setDialog({ type: "documents" })}><Plus className="size-4" />{t("review.new")}</Button></div> : <div className="overflow-hidden rounded-2xl border"><Table><TableHeader><TableRow className="bg-muted/20 hover:bg-muted/20"><TableHead className="pl-5">{t("review.name")}</TableHead><TableHead>{t("review.documents")}</TableHead><TableHead>{t("review.results")}</TableHead><TableHead>{t("review.updated")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{listing.data.reviews.map(item => <TableRow key={item.id} className="cursor-pointer" onClick={() => openReview(item.id)}><TableCell className="py-4 pl-5"><button className="flex items-center gap-3 text-left font-medium" onClick={event => { event.stopPropagation(); openReview(item.id); }}><Table2 className="size-4 text-muted-foreground" />{item.name}</button></TableCell><TableCell className="text-muted-foreground">{item.documents}</TableCell><TableCell><ReviewStatus status={item.status} /></TableCell><TableCell className="text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString(currentLocale())}</TableCell><TableCell className="pr-5"><ArrowUpRight className="size-4 text-muted-foreground" /></TableCell></TableRow>)}</TableBody></Table></div>}</div> : review && <>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3 lg:px-8">
        <div className="relative w-48 min-w-32"><Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" /><Input className="h-8 pl-8 text-xs" aria-label={t("review.search_documents")} placeholder={t("review.search_documents")} value={documentSearch} onChange={event => setDocumentSearch(event.target.value)} /></div>
        <div className="w-40"><ReviewSelect value={answerFilter} onChange={setAnswerFilter} label={t("review.results")} options={[{ value: "all", label: t("review.all_answers") }, { value: "attention", label: t("review.attention_only") }]} /></div>
        {pickedDocuments.length > 0 ? <div className="flex items-center gap-1"><span className="px-2 text-xs text-muted-foreground">{t("review.selected_count", { count: pickedDocuments.length })}</span><Button variant="ghost" size="sm" className="h-8 text-xs" disabled={busy || !review.columns.length} onClick={() => change.mutate({ type: "run", options: { documentIds: pickedDocuments, rerun: true } })}><RotateCcw className="size-3.5" />{t("review.rerun_selected")}</Button><Button variant="ghost" size="icon-sm" aria-label={t("review.clear_selection")} onClick={() => setSelectedDocuments([])}><X className="size-3.5" /></Button></div> : <div className="flex items-center gap-2 text-xs text-muted-foreground"><ReviewStatus status={review.status} /><span className="hidden xl:inline">{t("review.progress", { done, total: review.cells.length })}</span></div>}
        <Button variant="outline" size="sm" className="ml-auto h-8" disabled={busy} onClick={() => setDialog({ type: "library" })}><Plus className="size-3.5" />{t("review.add_column")}</Button>
      </div>
      {visibleReview && !visibleReview.documents.length && <p className="p-6 text-sm text-muted-foreground">{t("review.no_matching_documents")}</p>}
      {running && <div className="mx-6 h-0.5 bg-muted lg:mx-8"><div className="h-full bg-foreground transition-all" style={{ width: `${review.cells.length ? done / review.cells.length * 100 : 0}%` }} /></div>}
      <div className="mx-6 mb-6 flex min-h-0 flex-1 overflow-hidden rounded-2xl border lg:mx-8">{review.columns.length ? <div className="min-h-0 min-w-0 flex-1 overflow-hidden"><ReviewGrid review={visibleReview ?? review} busy={busy} selected={activeCell} selectedDocuments={pickedDocuments} onSelectDocuments={setSelectedDocuments} onSelect={setSelected} onEdit={column => setDialog({ type: "column", column })} onSave={columns => setDialog({ type: "save", columns })} onColumns={columns => change.mutate({ type: "columns", columns })} onAdd={() => setDialog({ type: "library" })} /></div> : <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center"><Table2 className="mb-4 size-8 text-muted-foreground/50" strokeWidth={1.3} /><h2 className="text-lg font-medium">{t("review.no_columns")}</h2><p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{t("review.no_columns_body")}</p><Button variant="outline" className="mt-5" onClick={() => setDialog({ type: "library" })}><BookOpen className="size-4" />{t("review.library")}</Button></div>}{activeCell && <ReviewCellDetail key={`${activeCell.documentId}:${activeCell.columnKey}`} client={client} workspaceId={workspaceId} review={review} cell={activeCell} busy={busy} onNavigate={setSelected} onClose={() => setSelected(null)} onRerun={() => change.mutate({ type: "run", options: { documentIds: [activeCell.documentId], columnKeys: [activeCell.columnKey], rerun: true } })} />}</div>
    </>}
    {dialog?.type === "documents" && <ReviewDocumentsDialog client={client} workspaceId={workspaceId} review={reviewId ? review : undefined} onClose={() => setDialog(null)} onSaved={value => { void refreshed(value); openReview(value.id); }} />}
    {dialog?.type === "settings" && <ReviewSettingsDialog client={client} workspaceId={workspaceId} review={reviewId ? review : undefined} onClose={() => setDialog(null)} />}
    {dialog?.type === "library" && <ReviewLibraryDialog client={client} workspaceId={workspaceId} review={reviewId ? review : undefined} onClose={() => setDialog(null)} onWrite={review ? () => setDialog({ type: "column" }) : undefined} />}
    {dialog?.type === "column" && review && <ReviewColumnDialog client={client} workspaceId={workspaceId} review={review} column={dialog.column} onClose={() => setDialog(null)} />}
    {dialog?.type === "save" && <SaveReviewPromptDialog client={client} workspaceId={workspaceId} columns={dialog.columns} onClose={() => setDialog(null)} />}
  </div>;
}
