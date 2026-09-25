import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { incompatibleJevQuestion, ReviewColumnSchema, type ReviewColumn, type ReviewLibraryEntry, type SavedReview } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { currentLocale, t } from "@/i18n";
import { ReviewError, ReviewSelect } from "./review-ui";
import { ReviewLibraryEditor } from "./review-library-editor";

export function ReviewColumnDialog({ client, workspaceId, review, column, onClose }: { client: LegalworkServerClient; workspaceId: string; review: SavedReview; column?: ReviewColumn; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ReviewColumn>(() => column ?? { key: `q_${crypto.randomUUID().slice(0, 8)}`, label: "", question: "", kind: "yes_no", options: [], hint: "" });
  const [options, setOptions] = useState(draft.options.join("\n"));
  const input = { ...draft, options: draft.kind === "classification" ? options.split("\n").map(option => option.trim()).filter(Boolean) : [] };
  const parsed = ReviewColumnSchema.safeParse(input);
  const incompatible = review.settings.mode === "jev" && incompatibleJevQuestion(input);
  const mutation = useMutation({ mutationFn: async () => {
    const value = ReviewColumnSchema.parse(input);
    await client.editReview(workspaceId, review.id, { revision: review.revision, columns: column ? review.columns.map(item => item.key === column.key ? value : item) : [...review.columns, value] });
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{t(column ? "review.edit_column" : "review.create_column")}</DialogTitle><DialogDescription>{t(`review.${review.settings.mode}_body`)}</DialogDescription></DialogHeader>
    <div className="space-y-4"><div className="space-y-2"><Label htmlFor="column-label">{t("review.column_label")}</Label><Input id="column-label" value={draft.label} maxLength={160} onChange={event => setDraft({ ...draft, label: event.target.value })} /></div>
      <div className="space-y-2"><Label>{t("review.kind")}</Label><ReviewSelect label={t("review.kind")} value={draft.kind} onChange={value => { const kind = ReviewColumnSchema.shape.kind.parse(value); setDraft({ ...draft, kind }); }} options={(review.settings.mode === "jev" ? ["yes_no", "classification"] : ["yes_no", "classification", "text"]).map(value => ({ value, label: t(`review.${value}`) }))} /></div>
      <div className="space-y-2"><Label htmlFor="column-question">{t("review.question")}</Label><Textarea id="column-question" className="min-h-28" value={draft.question} maxLength={8000} onChange={event => setDraft({ ...draft, question: event.target.value })} /></div>
      {draft.kind === "classification" && <div className="space-y-2"><Label htmlFor="column-options">{t("review.options")}</Label><Textarea id="column-options" value={options} onChange={event => setOptions(event.target.value)} /></div>}
      <div className="space-y-2"><Label htmlFor="column-hint">{t("review.hint")}</Label><Textarea id="column-hint" value={draft.hint} maxLength={2000} onChange={event => setDraft({ ...draft, hint: event.target.value })} /></div>
    </div>{incompatible && <p role="alert" className="text-sm text-warning">{t("review.library_conflict")}</p>}<ReviewError error={mutation.error} /><DialogFooter><Button variant="ghost" onClick={onClose}>{t("review.cancel")}</Button><Button disabled={!parsed.success || incompatible || mutation.isPending} onClick={() => mutation.mutate()}>{t("review.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function ReviewLibraryDialog({ client, workspaceId, review, onClose, onWrite }: { client: LegalworkServerClient; workspaceId: string; review?: SavedReview; onClose: () => void; onWrite?: () => void }) {
  const queryClient = useQueryClient();
  const language = currentLocale();
  const query = useQuery({ queryKey: ["review-library", workspaceId, language], queryFn: () => client.reviewLibrary(workspaceId, language) });
  const [editing, setEditing] = useState<ReviewLibraryEntry | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const entries = query.data?.entries.filter(entry => (filter === "all" || entry.source === filter) && `${entry.name} ${entry.description} ${entry.tags.join(" ")} ${entry.columns.map(column => column.question).join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const add = useMutation({ mutationFn: async ({ id, update }: { id: string; update?: boolean }) => {
    const entry = query.data?.entries.find(item => item.id === id); if (!entry || !review) return;
    const columns = entry.columns.map(column => ({ ...column, key: `${column.key.slice(0, 60)}_${crypto.randomUUID().slice(0, 8)}`, libraryId: entry.id, libraryVersion: entry.version, libraryColumnKey: column.key }));
    await client.editReview(workspaceId, review.id, { revision: review.revision, columns: update ? review.columns.map(column => {
      const latest = entry.columns.find(item => column.libraryId === entry.id && column.libraryColumnKey === item.key);
      return latest ? { ...latest, key: column.key, libraryId: entry.id, libraryVersion: entry.version, libraryColumnKey: latest.key } : column;
    }) : [...review.columns, ...columns] });
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); onClose(); } });
  const remove = useMutation({ mutationFn: (id: string) => client.removeReviewLibrary(workspaceId, id), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["review-library", workspaceId] }); } });
  if (editing) return <ReviewLibraryEditor client={client} workspaceId={workspaceId} entry={editing} onClose={() => setEditing(null)} />;
  return <Dialog open onOpenChange={open => { if (!open && !add.isPending) onClose(); }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{t("review.library")}</DialogTitle><DialogDescription>{t("review.library_body")}</DialogDescription></DialogHeader>
    <div className="flex gap-3"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={search} placeholder={t("review.search_library")} onChange={event => setSearch(event.target.value)} /></div><div className="w-36 shrink-0"><ReviewSelect label={t("review.library")} value={filter} onChange={setFilter} options={[{ value: "all", label: t("review.all") }, { value: "builtin", label: t("review.starters") }, { value: "personal", label: t("review.saved") }]} /></div></div>
    <ReviewError error={query.error || add.error || remove.error} />
    <div className="max-h-[50vh] space-y-2 overflow-auto pr-1">{query.isPending ? <p className="p-4 text-muted-foreground">{t("review.loading")}</p> : !entries.length ? <p className="p-4 text-muted-foreground">{t("review.library_empty")}</p> : entries.map(entry => {
      const incompatible = review?.settings.mode === "jev" && entry.columns.some(incompatibleJevQuestion);
      const outdated = review?.columns.some(column => column.libraryId === entry.id && column.libraryColumnKey && column.libraryVersion !== entry.version && entry.columns.some(item => item.key === column.libraryColumnKey));
      return <div key={entry.id} className="rounded-2xl border p-4"><div className="flex items-start gap-3"><BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{entry.name}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.description || entry.columns.map(column => column.question).join(" · ")}</p></div>{outdated && <Button variant="ghost" size="sm" disabled={incompatible || add.isPending} onClick={() => add.mutate({ id: entry.id, update: true })}>{t("review.update_columns")}</Button>}{review && <Button variant="outline" size="sm" disabled={incompatible || add.isPending || review.columns.length + entry.columns.length > 60} onClick={() => add.mutate({ id: entry.id })}><Plus className="size-3.5" />{t(entry.columns.length > 1 ? "review.add_set" : "review.add_column")}</Button>}{entry.source === "personal" && !review && <Button variant="ghost" size="icon-sm" aria-label={t("review.edit_saved")} onClick={() => setEditing(entry)}><Pencil className="size-4" /></Button>}{entry.source === "personal" && !review && <Button variant="ghost" size="icon-sm" aria-label={t("review.delete_prompt")} disabled={remove.isPending} onClick={() => remove.mutate(entry.id)}><Trash2 className="size-4" /></Button>}</div>
        <div className="mt-3 flex flex-wrap gap-1.5">{entry.columns.map(column => <span key={column.key} className="rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">{column.label} · {t(`review.${column.kind}`)}</span>)}</div><details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{t("review.inspect_prompt")}</summary><div className="mt-3 space-y-3">{entry.columns.map(column => <div key={column.key}><p className="font-medium">{column.label}</p><p className="mt-1 whitespace-pre-wrap leading-relaxed text-muted-foreground">{column.question}</p>{column.options.length > 0 && <p className="mt-1 text-muted-foreground">{column.options.join(" · ")}</p>}{column.hint && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{column.hint}</p>}</div>)}</div></details>{incompatible && <p className="mt-2 text-xs text-warning">{t("review.library_conflict")}</p>}
      </div>;
    })}</div>
    <DialogFooter>{onWrite && <Button variant="outline" onClick={onWrite}><Plus className="size-4" />{t("review.create_column")}</Button>}<Button variant="ghost" onClick={onClose}>{t("review.close")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function SaveReviewPromptDialog({ client, workspaceId, columns, onClose }: { client: LegalworkServerClient; workspaceId: string; columns: ReviewColumn[]; onClose: () => void }) {
  const [name, setName] = useState(columns.length === 1 ? columns[0].label : "");
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationFn: () => client.saveReviewLibrary(workspaceId, { name: name.trim(), columns, description: "", tags: [], language: currentLocale() }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["review-library", workspaceId] }); toast.success(t("review.prompt_saved")); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{t(columns.length > 1 ? "review.save_set" : "review.save_prompt")}</DialogTitle></DialogHeader><form onSubmit={event => { event.preventDefault(); mutation.mutate(); }} className="space-y-5"><Input aria-label={t("review.set_name")} value={name} maxLength={180} onChange={event => setName(event.target.value)} /><ReviewError error={mutation.error} /><DialogFooter><Button variant="ghost" type="button" onClick={onClose}>{t("review.cancel")}</Button><Button type="submit" disabled={!name.trim() || mutation.isPending}>{t("review.save")}</Button></DialogFooter></form></DialogContent></Dialog>;
}
