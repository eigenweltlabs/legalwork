import { reviewColumnLabel } from "./review-labels";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Layers, List, Copy, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { reviewLibraryKind, reviewLibraryPrompts, type ReviewLibraryEntry } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { currentLocale, t } from "@/i18n";
import { ReviewError, ReviewSelect } from "./review-ui";
import { HubTabs } from "../settings/segmented-tabs";
import { ReviewLibraryEditor } from "./review-library-editor";

type Editor = { kind: "prompt" | "set"; entry?: ReviewLibraryEntry; initialColumnKey?: string };
export function ReviewPromptLibrary({ client, workspaceId }: { client: LegalworkServerClient; workspaceId: string }) {
  const language = currentLocale(), queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["review-library", workspaceId, language], queryFn: () => client.reviewLibrary(workspaceId, language) });
  const [view, setView] = useState<"sets" | "prompts">("sets");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ReviewLibraryEntry | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => client.removeReviewLibrary(workspaceId, id), onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["review-library"] }); setRemoveTarget(null);
  } });
  const entries = (query.data?.entries ?? []).filter(entry => source === "all" || entry.source === source);
  const matches = (...text: string[]) => text.join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const sets = entries.filter(entry => reviewLibraryKind(entry) === "set");
  const prompts = reviewLibraryPrompts(entries);
  const edit = (entry: ReviewLibraryEntry, initialColumnKey?: string) => setEditor({ entry, kind: reviewLibraryKind(entry), initialColumnKey });
  const actions = (entry: ReviewLibraryEntry, initialColumnKey?: string) => <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("workflows.actions", { name: entry.name })} onClick={event => event.stopPropagation()} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DropdownMenuItem onClick={event => { event.stopPropagation(); edit(entry, initialColumnKey); }}>{entry.source === "personal" ? <Pencil /> : <Copy />}{t(entry.source === "personal" ? "common.edit" : "review.customize_copy")}</DropdownMenuItem>
      {entry.source === "personal" && <DropdownMenuItem variant="destructive" onClick={event => { event.stopPropagation(); setRemoveTarget(entry); }}><Trash2 />{t(reviewLibraryKind(entry) === "set" ? "review.delete_set" : "review.delete_prompt")}</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
  return <section className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-6 py-6" aria-label={t("review.prompts_title")}>
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-lg font-semibold tracking-tight">{t("review.prompts_title")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("review.prompts_body")}</p></div>
      <Button size="sm" onClick={() => setEditor({ kind: view === "sets" ? "set" : "prompt" })}><Plus className="size-4" />{t(view === "sets" ? "review.new_set" : "review.new_prompt")}</Button>
    </header>
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <HubTabs label={t("review.library")} value={view} onChange={setView} items={[
        { id: "sets", label: `${t("review.sets")} (${sets.length})`, icon: Layers },
        { id: "prompts", label: `${t("review.all_prompts")} (${prompts.length})`, icon: List },
      ]} />
      <div className="relative ml-auto min-w-40 flex-1 sm:max-w-xs"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="h-9 pl-9" aria-label={t("review.search_library")} placeholder={t("review.search_library")} value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="w-36"><ReviewSelect value={source} onChange={setSource} label={t("review.library_source")} options={[{ value: "all", label: t("review.all") }, { value: "builtin", label: t("review.starters") }, { value: "personal", label: t("review.saved") }]} /></div>
    </div>
    <p className="mb-4 text-xs text-muted-foreground">{t(view === "sets" ? "review.sets_body" : "review.all_prompts_body")}</p>
    <ReviewError error={query.error || remove.error} />
    <div className="min-h-0 overflow-auto rounded-xl border">
      <Table><TableHeader><TableRow className="bg-muted/20 hover:bg-muted/20"><TableHead className="pl-4">{t(view === "sets" ? "review.set_name_short" : "review.prompt_name")}</TableHead><TableHead>{t(view === "sets" ? "review.prompts" : "review.kind")}</TableHead><TableHead>{t("review.library_source")}</TableHead><TableHead className="w-12" /></TableRow></TableHeader>
        <TableBody>
          {view === "sets" ? sets.filter(entry => matches(entry.name, entry.description, ...entry.tags, ...entry.columns.map(column => `${column.label} ${column.question}`))).map(entry => <TableRow key={entry.id} className="cursor-pointer" onClick={() => edit(entry)}>
            <TableCell className="max-w-md whitespace-normal py-4 pl-4"><button className="text-left font-medium" onClick={event => { event.stopPropagation(); edit(entry); }}>{entry.name}</button><p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{entry.description}</p></TableCell>
            <TableCell className="text-xs text-muted-foreground"><span className="block">{t("review.prompt_count", { count: entry.columns.length })}</span></TableCell>
            <TableCell className="text-xs text-muted-foreground">{t(entry.source === "builtin" ? "review.starters" : "review.saved")}</TableCell><TableCell>{actions(entry)}</TableCell>
          </TableRow>) : prompts.filter(item => matches(item.column.label, item.column.question, item.column.hint, ...item.entry.tags, ...item.sets.map(set => set.name))).map(item => <TableRow key={item.id} className="cursor-pointer" onClick={() => edit(item.entry, item.column.key)}>
            <TableCell className="max-w-md whitespace-normal py-4 pl-4"><button className="text-left font-medium" onClick={event => { event.stopPropagation(); edit(item.entry, item.column.key); }}>{item.column.label}</button><p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.column.question}</p>{!!item.sets.length && <p className="mt-1 text-xs text-muted-foreground">{t("review.in_sets", { names: item.sets.map(set => set.name).join(", ") })}</p>}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{reviewColumnLabel(item.column.kind)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{t(item.entry.source === "builtin" ? "review.starters" : "review.saved")}</TableCell><TableCell>{actions(item.entry, item.column.key)}</TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
      {(query.isPending || (view === "sets" ? !sets.some(entry => matches(entry.name, entry.description, ...entry.tags, ...entry.columns.map(column => `${column.label} ${column.question}`))) : !prompts.some(item => matches(item.column.label, item.column.question, item.column.hint, ...item.entry.tags, ...item.sets.map(set => set.name))))) && <div className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground"><BookOpen className="size-5" /><p>{t(query.isPending ? "review.loading" : "review.library_empty")}</p></div>}
    </div>
    {editor && <ReviewLibraryEditor client={client} workspaceId={workspaceId} {...editor} onClose={() => setEditor(null)} />}
    <ConfirmModal open={!!removeTarget} title={t(removeTarget && reviewLibraryKind(removeTarget) === "set" ? "review.delete_set" : "review.delete_prompt")} message={t("review.delete_library_body", { name: removeTarget?.name ?? "" })} confirmLabel={t("review.remove")} cancelLabel={t("review.cancel")} confirmButtonVariant="destructive" onCancel={() => setRemoveTarget(null)} onConfirm={() => { if (removeTarget && !remove.isPending) remove.mutate(removeTarget.id); }} />
  </section>;
}
