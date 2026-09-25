import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { ReviewColumnSchema, SaveReviewLibrarySchema, type ReviewColumn, type ReviewLibraryEntry } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { ReviewError, ReviewSelect } from "./review-ui";

export function ReviewLibraryEditor({ client, workspaceId, entry, onClose }: {
  client: LegalworkServerClient; workspaceId: string; entry: ReviewLibraryEntry; onClose: () => void;
}) {
  const [name, setName] = useState(entry.name);
  const [description, setDescription] = useState(entry.description);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [columns, setColumns] = useState(entry.columns);
  const [selected, setSelected] = useState(0);
  const [options, setOptions] = useState(entry.columns[0].options.join("\n"));
  const column = columns[selected];
  const update = (value: Partial<ReviewColumn>) => setColumns(current => current.map((item, index) => index === selected ? { ...item, ...value } : item));
  const input = { id: entry.id, version: entry.version, language: entry.language, name, description, tags: tags.split(",").map(tag => tag.trim()).filter(Boolean), columns };
  const queryClient = useQueryClient();
  const save = useMutation({ mutationFn: () => client.saveReviewLibrary(workspaceId, SaveReviewLibrarySchema.parse(input)), onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["review-library"] }); onClose();
  } });
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{t("review.edit_saved")}</DialogTitle><DialogDescription>{t("review.library_version_body")}</DialogDescription></DialogHeader>
    <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
      <div className="space-y-2"><Label htmlFor="saved-prompt-name">{t("review.set_name")}</Label><Input id="saved-prompt-name" value={name} maxLength={180} onChange={event => setName(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="saved-prompt-description">{t("review.description")}</Label><Textarea id="saved-prompt-description" value={description} maxLength={1500} onChange={event => setDescription(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="saved-prompt-tags">{t("review.tags")}</Label><Input id="saved-prompt-tags" value={tags} onChange={event => setTags(event.target.value)} /></div>
      <div className="flex flex-wrap gap-2 border-t pt-4">{columns.map((item, index) => <Button key={item.key} size="sm" variant={selected === index ? "secondary" : "ghost"} onClick={() => { setSelected(index); setOptions(item.options.join("\n")); }}>{item.label || t("review.create_column")}</Button>)}<Button size="icon-sm" variant="outline" aria-label={t("review.add_column")} disabled={columns.length >= 60} onClick={() => { setColumns([...columns, { key: `q_${crypto.randomUUID().slice(0, 8)}`, label: "", question: "", kind: "yes_no", options: [], hint: "" }]); setSelected(columns.length); setOptions(""); }}><Plus className="size-4" /></Button></div>
      <div className="space-y-4 rounded-xl border p-4">
        <div className="flex items-end gap-3"><div className="min-w-0 flex-1 space-y-2"><Label htmlFor="saved-column-label">{t("review.column_label")}</Label><Input id="saved-column-label" value={column.label} maxLength={160} onChange={event => update({ label: event.target.value })} /></div><Button variant="ghost" size="icon" disabled={columns.length === 1} aria-label={t("review.remove")} onClick={() => { const next = columns.filter((_, index) => index !== selected); setColumns(next); setSelected(0); setOptions(next[0].options.join("\n")); }}><Trash2 className="size-4" /></Button></div>
        <div className="space-y-2"><Label>{t("review.kind")}</Label><ReviewSelect label={t("review.kind")} value={column.kind} options={["yes_no", "classification", "text"].map(value => ({ value, label: t(`review.${value}`) }))} onChange={value => { const kind = ReviewColumnSchema.shape.kind.parse(value); update({ kind, options: kind === "classification" ? options.split("\n").map(item => item.trim()).filter(Boolean) : [] }); }} /></div>
        <div className="space-y-2"><Label htmlFor="saved-column-question">{t("review.question")}</Label><Textarea id="saved-column-question" className="min-h-28" value={column.question} maxLength={8000} onChange={event => update({ question: event.target.value })} /></div>
        {column.kind === "classification" && <div className="space-y-2"><Label htmlFor="saved-column-options">{t("review.options")}</Label><Textarea id="saved-column-options" value={options} onChange={event => { setOptions(event.target.value); update({ options: event.target.value.split("\n").map(item => item.trim()).filter(Boolean) }); }} /></div>}
        <div className="space-y-2"><Label htmlFor="saved-column-hint">{t("review.hint")}</Label><Textarea id="saved-column-hint" value={column.hint} maxLength={2000} onChange={event => update({ hint: event.target.value })} /></div>
      </div>
    </div><ReviewError error={save.error} /><DialogFooter><Button variant="ghost" onClick={onClose}>{t("review.cancel")}</Button><Button disabled={!SaveReviewLibrarySchema.safeParse(input).success || save.isPending} onClick={() => save.mutate()}>{t("review.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
