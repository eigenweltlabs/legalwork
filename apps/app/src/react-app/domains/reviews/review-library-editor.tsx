import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, BookOpen, ChevronDown, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { SaveReviewLibrarySchema, reviewLibraryKind, reviewLibraryPrompts, type ReviewColumn, type ReviewLibraryEntry } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ReviewError } from "./review-ui";
import { validReviewOptions } from "./review-options";
import { ReviewPromptFields } from "./review-prompt-fields";

const emptyColumn = (): ReviewColumn => ({ key: `q_${crypto.randomUUID().slice(0, 8)}`, label: "", question: "", kind: "yes_no", options: [], hint: "" });
export function ReviewLibraryEditor({ client, workspaceId, entry, kind: requestedKind = "prompt", initialColumnKey, onClose }: {
  client: LegalworkServerClient; workspaceId: string; entry?: ReviewLibraryEntry; kind?: "prompt" | "set"; initialColumnKey?: string; onClose: () => void;
}) {
  const id = useId();
  const kind = entry ? reviewLibraryKind(entry) : requestedKind;
  const isSet = kind === "set", personal = entry?.source === "personal";
  const language = entry?.language ?? currentLocale();
  const [name, setName] = useState(entry?.name ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [tags, setTags] = useState(entry?.tags.join(", ") ?? "");
  const [details, setDetails] = useState(false);
  const [columns, setColumns] = useState(() => entry?.columns ?? [emptyColumn()]);
  const [selected, setSelected] = useState(Math.max(0, entry?.columns.findIndex(column => column.key === initialColumnKey) ?? 0));
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const column = columns[selected];
  const update = (value: Partial<ReviewColumn>) => {
    setColumns(current => current.map((item, index) => index === selected ? { ...item, ...value } : item));
    if (!isSet && value.label !== undefined) setName(value.label);
  };
  const input = { ...(personal ? { id: entry.id, version: entry.version } : {}), kind, language, name, description, tags: tags.split(",").map(tag => tag.trim()).filter(Boolean), columns: columns.map(column => ({ ...column, options: column.kind === "classification" || column.kind === "multi_select" ? column.options : [] })) };
  const queryClient = useQueryClient();
  const library = useQuery({ queryKey: ["review-library", workspaceId, currentLocale()], queryFn: () => client.reviewLibrary(workspaceId, currentLocale()), enabled: isSet && picking });
  const available = reviewLibraryPrompts(library.data?.entries ?? []).filter(item => `${item.column.label} ${item.column.question}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const save = useMutation({ mutationFn: () => client.saveReviewLibrary(workspaceId, SaveReviewLibrarySchema.parse(input)), onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["review-library"] }); onClose();
  } });
  const add = (value = emptyColumn()) => {
    if (columns.length === 1 && !columns[0].label && !columns[0].question) { setColumns([{ ...value, key: columns[0].key }]); setSelected(0); }
    else { setColumns([...columns, { ...value, key: `q_${crypto.randomUUID().slice(0, 8)}` }]); setSelected(columns.length); }
    setPicking(false);
  };
  const move = (offset: number) => {
    const next = [...columns];
    [next[selected], next[selected + offset]] = [next[selected + offset], next[selected]];
    setColumns(next); setSelected(selected + offset);
  };
  const canSave = SaveReviewLibrarySchema.safeParse(input).success && columns.every(column => (column.kind !== "classification" && column.kind !== "multi_select") || validReviewOptions(column.options));
  const metadata = <Collapsible open={details} onOpenChange={setDetails}>
    <CollapsibleTrigger disabled={save.isPending} render={<Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}><ChevronDown className={cn("size-3.5 transition-transform", !details && "-rotate-90")} />{t("review.library_details")}</CollapsibleTrigger>
    <CollapsibleContent className="space-y-4 pt-3">
      <Field className="gap-1.5"><FieldLabel htmlFor={`${id}-description`}>{t("review.description")}</FieldLabel><Textarea id={`${id}-description`} disabled={save.isPending} rows={2} value={description} maxLength={1500} onChange={event => setDescription(event.target.value)} /></Field>
      <Field className="gap-1.5"><FieldLabel htmlFor={`${id}-tags`}>{t("review.tags")}</FieldLabel><Input id={`${id}-tags`} disabled={save.isPending} value={tags} onChange={event => setTags(event.target.value)} /></Field>
    </CollapsibleContent>
  </Collapsible>;
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0", isSet ? "h-[min(760px,calc(100dvh-2rem))] sm:max-w-4xl" : "sm:max-w-xl")}>
    <DialogHeader className="shrink-0 px-6 pb-5 pt-6 pr-14">
      <DialogTitle>{t(personal ? isSet ? "review.edit_set" : "review.edit_prompt" : entry ? "review.customize_copy" : isSet ? "review.new_set" : "review.new_prompt")}</DialogTitle>
      {entry && !personal && <DialogDescription>{t("review.copy_body")}</DialogDescription>}
    </DialogHeader>
    {isSet ? <>
      <div className="max-h-[30vh] shrink-0 space-y-2 overflow-y-auto border-b px-6 pb-4">
        <Field className="gap-1.5"><FieldLabel htmlFor={`${id}-name`}>{t("review.set_name_short")}</FieldLabel><Input id={`${id}-name`} autoFocus value={name} maxLength={180} disabled={save.isPending} onChange={event => setName(event.target.value)} /></Field>
        {metadata}
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className="flex max-h-40 shrink-0 flex-col border-b bg-muted/20 sm:max-h-none sm:w-56 sm:border-b-0 sm:border-r" aria-label={t("review.prompts")}>
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2"><span className="text-xs font-medium text-muted-foreground">{t("review.prompts")} <span className="ml-1 tabular-nums">{columns.length}</span></span>
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("review.add_prompt")} disabled={save.isPending || columns.length >= 60} />}><Plus className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onClick={() => add()}><Plus />{t("review.new_prompt")}</DropdownMenuItem><DropdownMenuItem onClick={() => { setSearch(""); setPicking(true); }}><BookOpen />{t("review.from_library")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          </div>
          <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">{columns.map((item, index) => <li key={item.key}><button type="button" aria-current={!picking && selected === index ? "true" : undefined} disabled={save.isPending} onClick={() => { setSelected(index); setPicking(false); }} className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-2.5 text-left text-[13px] transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring", !picking && selected === index ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground")}><span className="w-4 shrink-0 text-xs tabular-nums leading-5 text-muted-foreground">{index + 1}</span><span className="min-w-0 break-words">{item.label || t("review.new_prompt")}</span></button></li>)}</ol>
        </aside>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
          {picking ? <div className="space-y-4">
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setPicking(false)}><ArrowLeft className="size-4" />{t("review.back_to_prompt")}</Button>
            <h3 className="text-sm font-medium">{t("review.add_existing_prompt")}</h3>
            <div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input autoFocus className="pl-9" aria-label={t("review.search_library")} placeholder={t("review.search_library")} value={search} onChange={event => setSearch(event.target.value)} /></div>
            <ReviewError error={library.error} />
            {library.isPending ? <p className="text-sm text-muted-foreground">{t("review.loading")}</p> : !available.length ? <p className="text-sm text-muted-foreground">{t("review.library_empty")}</p> : <div className="divide-y">{available.map(item => <button key={item.id} type="button" disabled={save.isPending} onClick={() => add(item.column)} className="flex w-full items-center gap-4 py-3 text-left transition-colors hover:bg-muted/30"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{item.column.label}</span><span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">{item.column.question}</span></span><Plus className="size-4 shrink-0 text-muted-foreground" /></button>)}</div>}
          </div> : <>
            <div className="mb-5 flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t("review.prompt_position", { index: selected + 1, count: columns.length })}</span><div className="flex items-center gap-1"><Button variant="ghost" size="icon-sm" disabled={save.isPending || selected === 0} aria-label={t("review.move_up")} onClick={() => move(-1)}><ArrowUp className="size-4" /></Button><Button variant="ghost" size="icon-sm" disabled={save.isPending || selected === columns.length - 1} aria-label={t("review.move_down")} onClick={() => move(1)}><ArrowDown className="size-4" /></Button><Button variant="ghost" size="icon-sm" className="ml-1 text-muted-foreground hover:text-destructive" disabled={save.isPending || columns.length === 1} aria-label={t("review.remove")} onClick={() => { setColumns(columns.filter((_, index) => index !== selected)); setSelected(Math.min(selected, columns.length - 2)); }}><Trash2 className="size-4" /></Button></div></div>
            <ReviewPromptFields key={column.key} column={column} disabled={save.isPending} onChange={update} />
          </>}
        </div>
      </div>
    </> : <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6"><ReviewPromptFields column={{ ...column, label: name }} disabled={save.isPending} onChange={update} />{metadata}</div>}
    {save.error && <div className="px-6 pb-4"><ReviewError error={save.error} /></div>}
    <DialogFooter className="m-0 shrink-0"><Button variant="ghost" disabled={save.isPending} onClick={onClose}>{t("review.cancel")}</Button><Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>{save.isPending && <Loader2 className="size-4 animate-spin" />}{t(entry && !personal ? "review.save_copy" : "review.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
