import { reviewModeLabel } from "./review-labels";
import { useState, type ReactNode } from "react";
import { LayoutSection, LayoutSectionItem } from "../settings/settings-layout";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReviewSettings, SavedReview } from "@legalwork/types/reviews";
import { incompatibleJevQuestion, reviewDecisionThreshold, reviewOcr, ReviewModeSchema, ReviewOcrSchema } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { ReviewError, ReviewSelect } from "./review-ui";
import { changeOrgPolicySetting, useOrgPolicy } from "../connections/org-policy";
import { OrgPolicyNote } from "../connections/org-policy-ui";

export function ReviewSettingsDialog({ client, workspaceId, review, onClose }: { client: LegalworkServerClient; workspaceId: string; review?: SavedReview; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t("review.settings")}</DialogTitle><DialogDescription>{t(review ? "review.settings_scope" : "review.defaults_scope")}</DialogDescription></DialogHeader>
      <ReviewSettingsForm client={client} workspaceId={workspaceId} review={review} onClose={onClose} onBusyChange={setBusy} />
    </DialogContent>
  </Dialog>;
}

function DialogFields({ children }: { children: ReactNode }) { return <div className="space-y-5">{children}</div>; }

export function ReviewSettingsForm({ client, workspaceId, review, onClose, onBusyChange, page = false }: { client: LegalworkServerClient; workspaceId: string; review?: SavedReview; onClose?: () => void; onBusyChange?: (busy: boolean) => void; page?: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["review-capabilities", workspaceId, review?.id], queryFn: () => client.reviewCapabilities(workspaceId, review?.id) });
  const [draft, setDraft] = useState<ReviewSettings | null>(null);
  const [thresholdText, setThresholdText] = useState<string | null>(null);
  const settings = draft ?? query.data?.settings;
  const excluded = settings?.mode === "jev" ? review?.columns.filter(incompatibleJevQuestion) ?? [] : [];
  const backends: Array<"jev" | "llm"> = ["jev", "llm"];
  const available = settings && backends.filter(backend => settings.mode === "mixed" || settings.mode === backend).map(backend => {
    const selected = settings[backend];
    return selected && query.data?.models.some(model => model.backend === (backend === "jev" ? "systemone" : "llm") && model.providerId === selected.providerId && model.model === selected.model);
  });
  const thresholdPercent = thresholdText ?? (settings ? String(Math.round(reviewDecisionThreshold(settings) * 100)) : "80");
  const thresholdValid = thresholdPercent.trim() !== "" && Number.isFinite(Number(thresholdPercent)) && Number(thresholdPercent) >= 50 && Number(thresholdPercent) <= 100;
  const valid = (settings?.mode === "llm" || thresholdValid) && available && (settings?.mode === "mixed" ? available.some(Boolean) : available.every(Boolean));
  const [saved, setSaved] = useState(false);
  // The firm's review defaults (not a single review's settings) may be managed.
  const firm = useOrgPolicy("reviews.defaults");
  const firmLocked = !review && firm?.locked === true;
  const mutation = useMutation({ mutationFn: async (reset: boolean) => {
    const save = async () => {
      if (reset) return client.resetReviewDefaults(workspaceId);
      if (settings) return client.saveReviewSettings(workspaceId, settings, review);
    };
    if (!review && firm) {
      await changeOrgPolicySetting("reviews.defaults", async () => { await save(); });
      return;
    }
    return save();
  }, onMutate: () => onBusyChange?.(true), onSettled: () => onBusyChange?.(false), onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] });
    await queryClient.invalidateQueries({ queryKey: ["review-capabilities"] });
    setDraft(null); setThresholdText(null); setSaved(true); onClose?.();
  } });
  const change = (value: ReviewSettings) => { setDraft(value); setSaved(false); };
  const Section = page ? LayoutSectionItem : "section";
  const Stack = page ? LayoutSection : DialogFields;
  return <div className="space-y-5">
      <ReviewError error={query.error || mutation.error} />
      {page && !review ? <OrgPolicyNote policyKey="reviews.defaults" /> : null}
      {settings ? <fieldset disabled={mutation.isPending || firmLocked} className="min-w-0 space-y-5"><Stack>
        <Section className="space-y-2"><Label>{t("review.mode")}</Label><ReviewSelect label={t("review.mode")} value={settings.mode} onChange={value => change({ ...settings, mode: ReviewModeSchema.parse(value) })} options={ReviewModeSchema.options.map(value => ({ value, label: reviewModeLabel(value) }))} /><p className="text-sm leading-relaxed text-muted-foreground">{t(settings.mode === "jev" ? "review.jev_body" : settings.mode === "mixed" ? "review.mixed_body" : "review.llm_body")}</p></Section>
        {excluded.length > 0 && <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"><p>{t("review.jev_excluded_columns")}</p><ul className="mt-2 max-h-24 space-y-1 overflow-y-auto">{excluded.map(column => <li key={column.key}>{column.label}</li>)}</ul></div>}
        {backends.filter(backend => settings.mode === "mixed" || settings.mode === backend).map(backend => {
          const models = query.data?.models.filter(model => model.backend === (backend === "jev" ? "systemone" : "llm")) ?? [];
          const selected = settings[backend];
          const providers = [...new Map(models.map(model => [model.providerId, { value: model.providerId, label: model.providerName }])).values()];
          const providerModels = models.filter(model => model.providerId === selected?.providerId);
          const unavailable = selected && !models.some(model => model.providerId === selected.providerId && model.model === selected.model);
          return <Section key={backend} className="space-y-3">
            <h3 className="text-sm font-medium">{t(backend === "jev" ? "review.jev_model" : "review.llm_model")}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>{t("review.provider")}</Label><ReviewSelect label={t("review.select_provider")} value={selected?.providerId ?? ""} options={providers} disabled={mutation.isPending || !providers.length} onChange={providerId => {
                const model = models.find(model => model.providerId === providerId);
                if (model) change({ ...settings, [backend]: { providerId, model: model.model } });
              }} /></div>
              <div className="space-y-2"><Label>{t("review.model")}</Label><ReviewSelect label={t("review.select_model")} value={selected?.model ?? ""} disabled={mutation.isPending || !providerModels.length} options={providerModels.map(model => ({ value: model.model, label: model.name }))} onChange={model => { if (selected) change({ ...settings, [backend]: { providerId: selected.providerId, model } }); }} /></div>
            </div>
            {(!models.length || unavailable) && <p className="text-sm text-muted-foreground">{t(unavailable ? "review.model_unavailable" : "review.no_models")}</p>}
          </Section>;
        })}
        {settings.mode !== "llm" && <Section className="space-y-2">
          <div className="flex items-center justify-between gap-4"><Label htmlFor="review-decision-threshold">{t("review.minimum_probability")}</Label>
            <div className="flex items-center gap-2"><Input id="review-decision-threshold" type="number" min={50} max={100} step={1} value={thresholdPercent} aria-invalid={!thresholdValid} className="h-8 w-20 text-right tabular-nums" onChange={event => {
              setThresholdText(event.target.value); setSaved(false);
              const probability = Number(event.target.value) / 100;
              if (Number.isFinite(probability) && probability >= .5 && probability <= 1) change({ ...settings, minDecisionProbability: probability });
            }} /><span className="text-sm text-muted-foreground">%</span></div>
          </div><p className="text-xs leading-relaxed text-muted-foreground">{t("review.minimum_probability_hint")}</p>
        </Section>}
        <Section className="space-y-2"><Label>{t("review.ocr_pages")}</Label><ReviewSelect label={t("review.ocr_pages")} value={reviewOcr(settings)} onChange={value => change({ ...settings, ocr: ReviewOcrSchema.parse(value) })} options={ReviewOcrSchema.options.map(value => ({ value, label: t(value === "always" ? "review.ocr_always" : "review.ocr_missing_text") }))} /><p className="text-sm leading-relaxed text-muted-foreground">{t(reviewOcr(settings) === "always" ? "review.ocr_always_body" : "review.ocr_missing_text_body")}</p></Section>
        </Stack>
        <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">{t("review.ocr_hint")}</p>
      </fieldset> : <p className="text-muted-foreground">{t("review.loading")}</p>}
      {page ? <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" disabled={mutation.isPending || !settings || firmLocked} onClick={() => mutation.mutate(true)}>{t("review.reset_defaults")}</Button>
        <div className="flex items-center gap-3">{saved && <span role="status" className="text-sm text-muted-foreground">{t("review.defaults_saved")}</span>}
          <Button disabled={!valid || mutation.isPending || firmLocked || (!draft && thresholdText === null)} onClick={() => mutation.mutate(false)}>{t("review.save")}</Button>
        </div>
      </div> : <DialogFooter><Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>{t("review.cancel")}</Button><Button onClick={() => mutation.mutate(false)} disabled={!valid || mutation.isPending}>{t("review.save")}</Button></DialogFooter>}
    </div>;
}
