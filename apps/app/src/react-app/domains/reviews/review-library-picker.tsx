import { reviewColumnLabel } from "./review-labels";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, List, Plus, Search } from "lucide-react";
import { incompatibleJevQuestion, reviewLibraryKind, reviewLibraryPrompts, type ReviewLibraryEntry, type SavedReview } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { HubTabs } from "../settings/segmented-tabs";
import { ReviewError, ReviewSelect } from "./review-ui";
import { ReviewLibraryEditor } from "./review-library-editor";

export function ReviewLibraryDialog({ client, workspaceId, review, onClose, onWrite }: {
  client: LegalworkServerClient; workspaceId: string; review?: SavedReview; onClose: () => void; onWrite?: () => void;
}) {
  const cache = useQueryClient(), language = currentLocale();
  const query = useQuery({ queryKey: ["review-library", workspaceId, language], queryFn: () => client.reviewLibrary(workspaceId, language) });
  const [view, setView] = useState<"sets" | "prompts">("sets");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<ReviewLibraryEntry | null>(null);
  const entries = (query.data?.entries ?? []).filter(entry => source === "all" || entry.source === source);
  const sets = entries.filter(entry => reviewLibraryKind(entry) === "set");
  const prompts = reviewLibraryPrompts(entries);
  const choices = (view === "sets" ? sets.map(entry => ({ id: entry.id, entry, title: entry.name, description: entry.description, columns: entry.columns }))
    : prompts.map(item => ({ id: item.id, entry: item.entry, title: item.column.label, description: item.column.question, columns: [item.column] })))
    .filter(item => `${item.title} ${item.description} ${item.entry.tags.join(" ")} ${item.columns.map(column => `${column.label} ${column.question}`).join(" ")}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const choice = choices.find(item => item.id === selected) ?? choices[0];
  const incompatible = review?.settings.mode === "jev" && choice?.columns.some(incompatibleJevQuestion);
  const outdated = choice && review?.columns.some(column => column.libraryId === choice.entry.id && column.libraryVersion !== choice.entry.version && choice.columns.some(item => item.key === column.libraryColumnKey));
  const add = useMutation({ mutationFn: async (update: boolean) => {
    if (!choice || !review) return;
    const entry = choice.entry;
    const columns = choice.columns.map(column => ({ ...column, key: `q_${crypto.randomUUID().slice(0, 8)}`, libraryId: entry.id, libraryVersion: entry.version, libraryColumnKey: column.key }));
    await client.editReview(workspaceId, review.id, { revision: review.revision, columns: update ? review.columns.map(column => {
      const latest = choice.columns.find(item => column.libraryId === entry.id && column.libraryColumnKey === item.key);
      return latest ? { ...latest, key: column.key, libraryId: entry.id, libraryVersion: entry.version, libraryColumnKey: latest.key } : column;
    }) : [...review.columns, ...columns] });
  }, onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); onClose(); } });
  if (editing) return <ReviewLibraryEditor client={client} workspaceId={workspaceId} entry={editing} onClose={() => setEditing(null)} />;
  return <Dialog open onOpenChange={open => { if (!open && !add.isPending) onClose(); }}>
    <DialogContent className="flex h-[min(720px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
      <DialogHeader className="px-6 pb-5 pt-6"><DialogTitle>{t("review.library")}</DialogTitle></DialogHeader>
      <div className="space-y-3 border-b px-6 pb-4">
        <HubTabs label={t("review.library")} value={view} onChange={setView} items={[{ id: "sets", label: t("review.sets"), icon: Layers }, { id: "prompts", label: t("review.all_prompts"), icon: List }]} />
        <div className="flex gap-3"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={search} aria-label={t("review.search_library")} placeholder={t("review.search_library")} onChange={event => setSearch(event.target.value)} /></div><div className="w-36"><ReviewSelect label={t("review.library_source")} value={source} onChange={setSource} options={[{ value: "all", label: t("review.all") }, { value: "builtin", label: t("review.starters") }, { value: "personal", label: t("review.saved") }]} /></div></div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="max-h-48 min-h-0 overflow-y-auto border-b p-2 sm:max-h-none sm:w-[42%] sm:shrink-0 sm:border-b-0 sm:border-r">
          {choices.map(item => <button key={item.id} type="button" aria-pressed={choice?.id === item.id} disabled={add.isPending} onClick={() => setSelected(item.id)} className={cn("mb-1 block w-full rounded-lg px-3 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring", choice?.id === item.id && "bg-muted/60")}><span className="block text-sm font-medium">{item.title}</span><span className="mt-1 block text-xs text-muted-foreground">{view === "sets" ? t("review.prompt_count", { count: item.columns.length }) : reviewColumnLabel(item.columns[0].kind)}</span></button>)}
          {!choices.length && <p className="p-4 text-sm text-muted-foreground">{t(query.isPending ? "review.loading" : "review.library_empty")}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-6" aria-label={t("review.inspect_prompt")}>
          {choice && <><h3 className="text-base font-semibold">{choice.title}</h3>{view === "sets" && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{choice.description}</p>}
            <div className="mt-5 divide-y">{choice.columns.map((column, index) => <div key={column.key} className="py-4 first:pt-0">{view === "sets" && <h4 className="mb-2 text-sm font-medium"><span className="mr-2 text-muted-foreground">{index + 1}.</span>{column.label}</h4>}<p className="whitespace-pre-wrap text-sm leading-relaxed">{column.question}</p><p className="mt-2 text-xs text-muted-foreground">{reviewColumnLabel(column.kind)}</p>{!!column.options.length && <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">{column.options.map(option => <li key={option}>{option}</li>)}</ul>}{column.hint && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("review.instructions")}</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{column.hint}</p></details>}</div>)}</div></>}
        </div>
      </div>
      {(query.error || add.error || incompatible) && <div className="border-t px-6 py-3"><ReviewError error={query.error || add.error} />{incompatible && <p className="text-sm text-warning">{t("review.library_conflict")}</p>}</div>}
      <DialogFooter className="m-0 shrink-0">
        {onWrite && <Button variant="outline" className="mr-auto" disabled={add.isPending} onClick={onWrite}><Plus className="size-4" />{t("review.create_column")}</Button>}
        <Button variant="ghost" disabled={add.isPending} onClick={onClose}>{t("review.close")}</Button>
        {outdated && <Button variant="outline" disabled={incompatible || add.isPending} onClick={() => add.mutate(true)}>{t("review.update_columns")}</Button>}
        {review ? <Button disabled={!choice || incompatible || add.isPending || review.columns.length + choice.columns.length > 60} onClick={() => add.mutate(false)}><Plus className="size-4" />{t(view === "sets" ? "review.add_set" : "review.add_column")}</Button>
          : choice && <Button onClick={() => setEditing(choice.entry)}>{t(choice.entry.source === "personal" ? "common.edit" : "review.customize_copy")}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
