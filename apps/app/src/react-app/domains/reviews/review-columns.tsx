import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { incompatibleJevQuestion, ReviewColumnKindSchema, ReviewColumnSchema, type ReviewColumn, type SavedReview } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { currentLocale, t } from "@/i18n";
import { ReviewError } from "./review-ui";
import { ReviewPromptFields } from "./review-prompt-fields";
import { validReviewOptions } from "./review-options";

export function ReviewColumnDialog({ client, workspaceId, review, column, onClose }: { client: LegalworkServerClient; workspaceId: string; review: SavedReview; column?: ReviewColumn; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ReviewColumn>(() => column ?? { key: `q_${crypto.randomUUID().slice(0, 8)}`, label: "", question: "", kind: "yes_no", options: [], hint: "" });
  const choice = draft.kind === "classification" || draft.kind === "multi_select";
  const input = { ...draft, options: choice ? draft.options.map(option => option.trim()) : [] };
  const validOptions = !choice || validReviewOptions(draft.options);
  const parsed = ReviewColumnSchema.safeParse(input);
  const incompatible = review.settings.mode === "jev" && incompatibleJevQuestion(input);
  const mutation = useMutation({ mutationFn: async () => {
    const value = ReviewColumnSchema.parse(input);
    await client.editReview(workspaceId, review.id, { revision: review.revision, columns: column ? review.columns.map(item => item.key === column.key ? value : item) : [...review.columns, value] });
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl"><DialogHeader><DialogTitle>{t(column ? "review.edit_column" : "review.create_column")}</DialogTitle></DialogHeader>
    <div className="min-h-0 overflow-y-auto"><ReviewPromptFields column={draft} nameLabel={t("review.column_label")} disabled={mutation.isPending} kinds={review.settings.mode === "jev" ? ["yes_no", "classification"] : ReviewColumnKindSchema.options} onChange={change => setDraft(current => ({ ...current, ...change }))} /></div>
    {incompatible && <p role="alert" className="text-sm text-warning">{t("review.library_conflict")}</p>}<ReviewError error={mutation.error} /><DialogFooter className="shrink-0"><Button variant="ghost" disabled={mutation.isPending} onClick={onClose}>{t("review.cancel")}</Button><Button disabled={!parsed.success || !validOptions || incompatible || mutation.isPending} onClick={() => mutation.mutate()}>{t("review.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export { ReviewLibraryDialog } from "./review-library-picker";

export function SaveReviewPromptDialog({ client, workspaceId, columns, onClose }: { client: LegalworkServerClient; workspaceId: string; columns: ReviewColumn[]; onClose: () => void }) {
  const [name, setName] = useState(columns.length === 1 ? columns[0].label : "");
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationFn: () => client.saveReviewLibrary(workspaceId, { name: name.trim(), columns, description: "", tags: [], language: currentLocale() }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["review-library", workspaceId] }); toast.success(t("review.prompt_saved")); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{t(columns.length > 1 ? "review.save_set" : "review.save_prompt")}</DialogTitle></DialogHeader><form onSubmit={event => { event.preventDefault(); mutation.mutate(); }} className="space-y-5"><Input aria-label={t("review.set_name")} value={name} maxLength={180} onChange={event => setName(event.target.value)} /><ReviewError error={mutation.error} /><DialogFooter><Button variant="ghost" type="button" onClick={onClose}>{t("review.cancel")}</Button><Button type="submit" disabled={!name.trim() || mutation.isPending}>{t("review.save")}</Button></DialogFooter></form></DialogContent></Dialog>;
}
