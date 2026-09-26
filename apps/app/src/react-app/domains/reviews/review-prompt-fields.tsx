import { reviewColumnLabel } from "./review-labels";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ReviewColumnKindSchema, type ReviewColumn } from "@legalwork/types/reviews";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ReviewOptions } from "./review-options";
import { ReviewSelect } from "./review-ui";

/** One question form, shared by saved prompts, sets, and review columns. */
export function ReviewPromptFields({ column, onChange, kinds = ReviewColumnKindSchema.options, nameLabel = t("review.prompt_name"), disabled }: {
  column: ReviewColumn; onChange: (change: Partial<ReviewColumn>) => void; kinds?: ReviewColumn["kind"][]; nameLabel?: string; disabled?: boolean;
}) {
  const id = useId();
  const [instructions, setInstructions] = useState(false);
  return <fieldset disabled={disabled} className="min-w-0 space-y-5">
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
      <Field className="gap-1.5"><FieldLabel htmlFor={`${id}-name`}>{nameLabel}</FieldLabel><Input id={`${id}-name`} value={column.label} maxLength={160} onChange={event => onChange({ label: event.target.value })} /></Field>
      <Field className="gap-1.5"><FieldLabel>{t("review.kind")}</FieldLabel><ReviewSelect disabled={disabled} label={t("review.kind")} value={column.kind} options={kinds.map(value => ({ value, label: reviewColumnLabel(value) }))} onChange={value => onChange({ kind: ReviewColumnKindSchema.parse(value) })} /></Field>
    </div>
    <Field className="gap-1.5"><FieldLabel htmlFor={`${id}-question`}>{t("review.question")}</FieldLabel><Textarea id={`${id}-question`} rows={4} className="resize-y" value={column.question} maxLength={8000} placeholder={t("review.question_placeholder")} onChange={event => onChange({ question: event.target.value })} /></Field>
    {(column.kind === "classification" || column.kind === "multi_select") && <ReviewOptions key={column.key} value={column.options} disabled={disabled} onChange={options => onChange({ options })} />}
    <Collapsible open={instructions} onOpenChange={setInstructions}>
      <CollapsibleTrigger disabled={disabled} render={<Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" />}><ChevronDown className={cn("size-3.5 transition-transform", !instructions && "-rotate-90")} />{t("review.hint")}</CollapsibleTrigger>
      <CollapsibleContent><Textarea className="mt-2 resize-y" rows={4} aria-label={t("review.hint")} value={column.hint} maxLength={2000} onChange={event => onChange({ hint: event.target.value })} /></CollapsibleContent>
    </Collapsible>
  </fieldset>;
}
