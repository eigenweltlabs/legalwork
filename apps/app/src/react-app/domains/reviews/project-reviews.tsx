import { reviewActionLabel, reviewModeLabel, reviewStatusLabel } from "./review-labels";
import { useDeferredValue, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { workspaceSettingsRoute } from "../../shell/workspace-routes";
import { ArrowLeft, ArrowUpRight, BookOpen, Download, FileText, MessageSquare, MoreHorizontal, Play, Plus, RotateCcw, Settings2, Square, Table2, Trash2, X } from "lucide-react";
import type { ReviewCell, ReviewColumn, RunReview, SavedReview } from "@legalwork/types/reviews";
import { incompatibleJevQuestion, reviewRunAction } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { currentLocale, t } from "@/i18n";
import { useComposerStateStore } from "../session/surface/composer-state-store";
import { createReviewComposerMention, encodeComposerMentionValue } from "../session/surface/composer/mention-encoding";
import { ReviewNameDialog } from "./review-documents";
import { ReviewFileDropTarget, ReviewFilePicker, useReviewFileIntake } from "./review-file-intake";
import { ReviewSettingsDialog } from "./review-settings";
import { ReviewColumnDialog, ReviewLibraryDialog, SaveReviewPromptDialog } from "./review-columns";
import { ReviewFilterControls, emptyReviewFilters, reviewFilterQuery } from "./review-filters";
import { ReviewGrid, ReviewCellDetail } from "./review-grid";
import { ReviewError, ReviewStatus, reviewAnswer, reviewProbabilityRows, reviewKey } from "./review-ui";

type DialogState = { type: "name" } | { type: "settings" | "library" } | { type: "column"; column?: ReviewColumn } | { type: "save"; columns: ReviewColumn[] } | null;
function exportReview(review: SavedReview) {
  // Neutralize spreadsheet formulas in user/document/model-controlled values.
  const csv = (value: string) => `"${(/^[=+@\-\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  const rows = [[t("review.documents"), ...review.columns.map(column => column.label)], ...review.documents.map(document => [document.name, ...review.columns.map(column => {
    const cell = review.cells.find(item => item.documentId === document.id && item.columnKey === column.key);
    return cell?.result ? `${reviewAnswer(cell.result)}${cell.result.decision ? ` [${reviewProbabilityRows(cell.result).map(({ label, probability }) => `${label}: ${(probability * 100).toFixed(1)}%`).join("; ")}]` : ""}${cell.status === "complete" ? "" : ` (${reviewStatusLabel(cell.status)})`}` : cell ? reviewStatusLabel(cell.status) : "";
  })])];
  const url = URL.createObjectURL(new Blob(["\uFEFF", rows.map(row => row.map(csv).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${review.name.replace(/[/\\:*?"<>|]/g, "-")}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ProjectReviews({ client, workspaceId, projectName, onOpenSession }: { client: LegalworkServerClient; workspaceId: string; projectName: string; onOpenSession: (sessionId: string) => void }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewId = searchParams.get("review");
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(emptyReviewFilters);
  const deferredFilters = useDeferredValue(filters);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [removeTarget, setRemoveTarget] = useState<Pick<SavedReview, "id" | "name" | "revision"> | null>(null);
  const [selectedDocuments, setSelectedDocuments] = useState<string[]>([]);
  const [selected, setSelected] = useState<Pick<ReviewCell, "documentId" | "columnKey"> | null>(null);
  const listing = useQuery({ queryKey: reviewKey(workspaceId), queryFn: () => client.listReviews(workspaceId), refetchInterval: query => query.state.data?.reviews.some(review => review.status === "running") ? 3000 : false });
  const detail = useQuery({ queryKey: reviewKey(workspaceId, reviewId ?? "none"), queryFn: () => client.getReview(workspaceId, reviewId!, queryClient.getQueryData<SavedReview>(reviewKey(workspaceId, reviewId!))), enabled: !!reviewId, refetchInterval: query => query.state.data?.status === "running" ? 1000 : 5000 });
  const review = detail.data;
  const filterQuery = review ? reviewFilterQuery(review, deferredFilters) : { input: undefined, error: undefined };
  const rows = useQuery({ queryKey: ["review-rows", workspaceId, reviewId, review?.revision, filterQuery.input],
    queryFn: () => client.queryReviewRows(workspaceId, reviewId!, filterQuery.input!), enabled: !!review && !!filterQuery.input,
    placeholderData: (previous, query) => query?.queryKey[1] === workspaceId && query.queryKey[2] === reviewId ? previous : undefined,
  });
  const rowIds = rows.data?.documentIds;
  const documentsById = new Map(review?.documents.map(document => [document.id, document]));
  const visibleReview = review && { ...review, documents: filterQuery.error ? [] : rowIds ? rowIds.flatMap(id => { const document = documentsById.get(id); return document ? [document] : []; }) : [] };
  const runAction = review ? reviewRunAction(review) : "run";
  const linkedSession = useQuery({ queryKey: ["review-session", workspaceId, reviewId], queryFn: () => client.getReviewSession(workspaceId, reviewId!), enabled: !!review, staleTime: 30_000 });
  const discussion = useMutation({ mutationFn: async () => {
    if (!review) throw new Error(t("review.failed"));
    const result = await client.openReviewSession(workspaceId, review.id);
    const composer = useComposerStateStore.getState();
    if (result.prefill && !composer.sessions[result.sessionId]?.draft) {
      const reference = createReviewComposerMention(review.id, review.name);
      composer.setMentions(result.sessionId, { ...composer.sessions[result.sessionId]?.mentions, [reference]: "review" });
      composer.setDraft(result.sessionId, `@${encodeComposerMentionValue(reference)} ${t("review.discussion_draft")}`);
    }
    return result;
  }, onSuccess: result => {
    queryClient.setQueryData(["review-session", workspaceId, reviewId], { sessionId: result.sessionId });
    onOpenSession(result.sessionId);
  } });
  const running = review?.status === "running";
  const runnable = review?.columns.some(column => review.settings.mode !== "jev" || !incompatibleJevQuestion(column));
  const openReview = (id?: string) => { setSelected(null); setSelectedDocuments([]); setFilters(emptyReviewFilters); setSearchParams(id ? { review: id } : {}); };
  const remove = useMutation({ mutationFn: (target: Pick<SavedReview, "id" | "revision">) => client.deleteReview(workspaceId, target.id, target.revision), onSuccess: async (_result, target) => {
    if (reviewId === target.id) openReview();
    setDialog(null);
    await queryClient.cancelQueries({ queryKey: reviewKey(workspaceId, target.id) });
    queryClient.removeQueries({ queryKey: reviewKey(workspaceId, target.id), exact: true });
    queryClient.removeQueries({ queryKey: ["review-session", workspaceId, target.id], exact: true });
    await queryClient.invalidateQueries({ queryKey: reviewKey(workspaceId) });
  }, onError: () => { void queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); } });
  const refreshed = async (value: SavedReview) => { queryClient.setQueryData(reviewKey(workspaceId, value.id), value); await queryClient.invalidateQueries({ queryKey: reviewKey(workspaceId) }); };
  const change = useMutation({ mutationFn: async (action: { type: "columns"; columns: ReviewColumn[] } | { type: "run"; options?: Partial<RunReview> } | { type: "stop" } | { type: "files"; files: string[] }) => {
    if (!review) throw new Error(t("review.failed"));
    if (action.type === "columns") return client.editReview(workspaceId, review.id, { revision: review.revision, columns: action.columns });
    if (action.type === "files") return client.editReview(workspaceId, review.id, { revision: review.revision, files: action.files });
    if (action.type === "stop") return client.cancelReview(workspaceId, review.id);
    return client.startReview(workspaceId, review.id, { revision: review.revision, rerun: false, reprocess: false, ...action.options });
  }, onSuccess: refreshed, onError: () => { void queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); } });
  const intake = useReviewFileIntake({ client, workspaceId, existing: review?.documents.map(document => document.path) ?? [], onFiles: async paths => {
    if (!reviewId) {
      const created = await client.createReview(workspaceId, { name: t("review.untitled"), files: paths, columns: [], requestId: crypto.randomUUID() });
      await refreshed(created); openReview(created.id); return;
    }
    // Re-read after a download, so adding files preserves any intervening edits.
    const latest = await client.getReview(workspaceId, reviewId);
    const files = [...new Set([...latest.documents.map(document => document.path), ...paths])];
    if (files.length !== latest.documents.length) await refreshed(await client.editReview(workspaceId, reviewId, { revision: latest.revision, files }));
  } });
  const activeCell = visibleReview?.documents.some(document => document.id === selected?.documentId)
    ? review?.cells.find(cell => cell.documentId === selected?.documentId && cell.columnKey === selected.columnKey) : undefined;
  const done = review?.cells.filter(cell => ["complete", "needs_review", "error"].includes(cell.status)).length ?? 0;
  const busy = !!running || change.isPending || intake.busy || remove.isPending;
  const error = intake.error || (reviewId ? detail.error : listing.error) || change.error || discussion.error || remove.error || rows.error;
  const pickedDocuments = selectedDocuments.filter(id => review?.documents.some(document => document.id === id));
  return <ReviewFileDropTarget disabled={busy || !!dialog || !!removeTarget || (!!reviewId && !review)} onFiles={sources => void intake.add(sources)} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
    <header className="shrink-0 px-6 pb-4 pt-5 lg:px-8">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">{reviewId ? <Button variant="ghost" size="sm" className="-ml-2 h-6 text-xs" disabled={intake.busy} onClick={() => openReview()}><ArrowLeft className="size-3.5" />{t("review.back")}</Button> : <span>{projectName}</span>}</div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-xl font-semibold tracking-tight">{reviewId ? review?.name ?? t("review.loading") : t("review.title")}</h1>{!reviewId && <p className="mt-1.5 text-sm text-muted-foreground">{t("review.subtitle")}</p>}</div>
        <div className="flex items-center gap-2">{!reviewId ? <>
          <ReviewFilePicker disabled={busy} onFiles={sources => void intake.add(sources)} />
          <Button variant="outline" disabled={intake.busy} onClick={() => setDialog({ type: "library" })}><BookOpen className="size-4" />{t("review.library")}</Button><Button variant="ghost" size="icon" aria-label={t("review.settings")} disabled={intake.busy} onClick={() => navigate(workspaceSettingsRoute(workspaceId, "tabular-review"))}><Settings2 className="size-4" /></Button><Button disabled={intake.busy} onClick={() => setDialog({ type: "name" })}><Plus className="size-4" />{t("review.new")}</Button>
        </> : review && <>
          <Button variant="ghost" size="sm" disabled={busy} aria-label={t("review.settings")} onClick={() => setDialog({ type: "settings" })}><Settings2 className="size-3.5" />{reviewModeLabel(review.settings.mode)}</Button>
          <Button variant="outline" disabled={discussion.isPending} onClick={() => discussion.mutate()}><MessageSquare className="size-4" />{t(linkedSession.data?.sessionId ? "review.continue_session" : "review.discuss_session")}</Button>
          {running ? <Button size="sm" variant="outline" disabled={change.isPending} onClick={() => change.mutate({ type: "stop" })}><Square className="size-3.5" />{t("review.stop")}</Button> : <Button size="sm" disabled={!runnable || !review.documents.length || busy} onClick={() => change.mutate({ type: "run", options: { rerun: runAction === "rerun_all", retryFailed: runAction === "retry_failed" } })}>{runAction === "rerun_all" ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}{reviewActionLabel(runAction)}</Button>}
          <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("review.actions")} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end">
            <DropdownMenuItem disabled={busy || !review.cells.some(cell => cell.status === "error")} onClick={() => change.mutate({ type: "run", options: { retryFailed: true } })}><RotateCcw />{t("review.retry_failed")}</DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onClick={() => setDialog({ type: "name" })}><FileText />{t("review.rename")}</DropdownMenuItem><DropdownMenuItem disabled={busy || !review.columns.length} onClick={() => setDialog({ type: "save", columns: review.columns })}><BookOpen />{t("review.save_set")}</DropdownMenuItem><DropdownMenuItem disabled={busy || !runnable} onClick={() => change.mutate({ type: "run", options: { rerun: true } })}><RotateCcw />{t("review.rerun_all")}</DropdownMenuItem><DropdownMenuItem disabled={!review.cells.some(cell => cell.result)} onClick={() => exportReview(review)}><Download />{t("review.export")}</DropdownMenuItem>
            <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={busy} title={running ? t("review.stop_to_delete") : undefined} onClick={() => { remove.reset(); setRemoveTarget(review); }}><Trash2 />{t("review.delete")}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
        </>}</div>
      </div>
    </header>
    {(intake.progress || error) && <div className="space-y-3 px-6 pb-4 lg:px-8">{intake.progress && <p role="status" className="text-sm text-muted-foreground">{intake.progress}</p>}<ReviewError error={error} /></div>}
    {!reviewId ? <div className="min-h-0 flex-1 overflow-auto px-6 pb-8 lg:px-8">{listing.isPending ? <p className="py-8 text-muted-foreground">{t("review.loading")}</p> : !listing.data?.reviews.length ? <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center"><div className="mb-5 rounded-2xl border bg-muted/20 p-4"><Table2 className="size-7 text-muted-foreground" strokeWidth={1.4} /></div><h2 className="text-lg font-medium tracking-tight">{t("review.empty")}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("review.empty_body")}</p><Button className="mt-6" disabled={intake.busy} onClick={() => setDialog({ type: "name" })}><Plus className="size-4" />{t("review.new")}</Button></div> : <div className="overflow-hidden rounded-2xl border"><Table><TableHeader><TableRow className="bg-muted/20 hover:bg-muted/20"><TableHead className="pl-5">{t("review.name")}</TableHead><TableHead>{t("review.documents")}</TableHead><TableHead>{t("review.results")}</TableHead><TableHead>{t("review.updated")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{listing.data.reviews.map(item => <TableRow key={item.id} className="cursor-pointer" onClick={() => { if (!intake.busy) openReview(item.id); }}><TableCell className="py-4 pl-5"><button className="flex items-center gap-3 text-left font-medium" onClick={event => { event.stopPropagation(); if (!intake.busy) openReview(item.id); }}><Table2 className="size-4 text-muted-foreground" />{item.name}</button></TableCell><TableCell className="text-muted-foreground">{item.documents}</TableCell><TableCell><ReviewStatus status={item.status} /></TableCell><TableCell className="text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString(currentLocale())}</TableCell><TableCell className="pr-5"><div className="flex items-center justify-end gap-2"><Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={t("review.delete_named", { name: item.name })} title={t(item.status === "running" ? "review.stop_to_delete" : "review.delete")} disabled={busy || item.status === "running"} onClick={event => { event.stopPropagation(); remove.reset(); setRemoveTarget(item); }}><Trash2 className="size-4" /></Button><ArrowUpRight className="size-4 text-muted-foreground" /></div></TableCell></TableRow>)}</TableBody></Table></div>}</div> : review && <>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3 lg:px-8">
        <ReviewFilterControls review={review} value={filters} onChange={setFilters} />
        {pickedDocuments.length > 0 ? <div className="flex items-center gap-1"><span className="px-2 text-xs text-muted-foreground">{t("review.selected_count", { count: pickedDocuments.length })}</span><Button variant="ghost" size="sm" className="h-8 text-xs" disabled={busy || !runnable} onClick={() => change.mutate({ type: "run", options: { documentIds: pickedDocuments, rerun: true } })}><RotateCcw className="size-3.5" />{t("review.rerun_selected")}</Button><Button variant="ghost" size="sm" className="h-8 text-xs" disabled={busy} onClick={() => change.mutate({ type: "files", files: review.documents.filter(document => !pickedDocuments.includes(document.id)).map(document => document.path) })}><Trash2 className="size-3.5" />{t("review.remove")}</Button><Button variant="ghost" size="icon-sm" aria-label={t("review.clear_selection")} onClick={() => setSelectedDocuments([])}><X className="size-3.5" /></Button></div> : <div className="flex items-center gap-2 text-xs text-muted-foreground"><ReviewStatus status={review.status} /><span className="hidden xl:inline">{t("review.progress", { done, total: review.cells.length })}</span>{running && <span role="status">{t("review.processing_progress", { preparing: review.documents.filter(document => document.status === "preparing").length, running: review.cells.filter(cell => cell.status === "running").length, queued: review.cells.filter(cell => cell.status === "queued").length })}</span>}</div>}
        <div className="ml-auto"><ReviewFilePicker disabled={busy} onFiles={sources => void intake.add(sources)} /></div>
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => setDialog({ type: "library" })}><Plus className="size-3.5" />{t("review.add_column")}</Button>
      </div>
      {filterQuery.error && <p role="status" className="px-6 pb-3 text-sm text-muted-foreground">{t(filterQuery.error)}</p>}
      {visibleReview && !visibleReview.documents.length && !filterQuery.error && <p className="p-6 text-sm text-muted-foreground">{t(rows.isPending ? "review.loading" : "review.no_matching_documents")}</p>}
      {running && <div className="mx-6 h-0.5 bg-muted lg:mx-8"><div className="h-full bg-foreground transition-all" style={{ width: `${review.cells.length ? done / review.cells.length * 100 : 0}%` }} /></div>}
      {!!visibleReview?.documents.length && <div aria-busy={rows.isFetching} className="mx-6 mb-6 flex min-h-0 flex-1 overflow-hidden rounded-2xl border lg:mx-8"><div className="min-h-0 min-w-0 flex-1 overflow-hidden"><ReviewGrid review={visibleReview} busy={busy} selected={activeCell} selectedDocuments={pickedDocuments} onSelectDocuments={setSelectedDocuments} onSelect={setSelected} onEdit={column => setDialog({ type: "column", column })} onSave={columns => setDialog({ type: "save", columns })} onColumns={columns => change.mutate({ type: "columns", columns })} onAdd={() => setDialog({ type: "library" })} /></div>{activeCell && <ReviewCellDetail key={`${activeCell.documentId}:${activeCell.columnKey}`} client={client} workspaceId={workspaceId} review={visibleReview} cell={activeCell} busy={busy} onNavigate={setSelected} onClose={() => setSelected(null)} onRerun={() => change.mutate({ type: "run", options: { documentIds: [activeCell.documentId], columnKeys: [activeCell.columnKey], rerun: true } })} />}</div>}
    </>}

    <ConfirmModal open={!!removeTarget} title={t("review.delete_title")} message={t("review.delete_body", { name: removeTarget?.name ?? "" })} confirmLabel={t("review.delete")} cancelLabel={t("review.cancel")} variant="danger" onCancel={() => setRemoveTarget(null)} onConfirm={() => { const target = removeTarget; setRemoveTarget(null); if (target && !remove.isPending) remove.mutate(target); }} />
    {dialog?.type === "name" && <ReviewNameDialog client={client} workspaceId={workspaceId} review={reviewId ? review : undefined} onClose={() => setDialog(null)} onSaved={value => { void refreshed(value); openReview(value.id); }} />}
    {dialog?.type === "settings" && <ReviewSettingsDialog client={client} workspaceId={workspaceId} review={reviewId ? review : undefined} onClose={() => setDialog(null)} />}
    {dialog?.type === "library" && <ReviewLibraryDialog client={client} workspaceId={workspaceId} review={reviewId ? review : undefined} onClose={() => setDialog(null)} onWrite={review ? () => setDialog({ type: "column" }) : undefined} />}
    {dialog?.type === "column" && review && <ReviewColumnDialog client={client} workspaceId={workspaceId} review={review} column={dialog.column} onClose={() => setDialog(null)} />}
    {dialog?.type === "save" && <SaveReviewPromptDialog client={client} workspaceId={workspaceId} columns={dialog.columns} onClose={() => setDialog(null)} />}
  </ReviewFileDropTarget>;
}
