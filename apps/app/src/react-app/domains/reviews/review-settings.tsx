import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReviewSettings, SavedReview } from "@legalwork/types/reviews";
import { ReviewModeSchema } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { ReviewError, ReviewSelect } from "./review-ui";

export function ReviewSettingsDialog({ client, workspaceId, review, onClose }: { client: LegalworkServerClient; workspaceId: string; review?: SavedReview; onClose: () => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["review-capabilities", workspaceId, review?.id], queryFn: () => client.reviewCapabilities(workspaceId, review?.id) });
  const [draft, setDraft] = useState<ReviewSettings | null>(null);
  const settings = draft ?? query.data?.settings;
  const backends: Array<"jev" | "llm"> = ["jev", "llm"];
  const mutation = useMutation({ mutationFn: async () => { if (!settings) return; await client.saveReviewSettings(workspaceId, settings, review); }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); await queryClient.invalidateQueries({ queryKey: ["review-capabilities", workspaceId] }); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t("review.settings")}</DialogTitle><DialogDescription>{t(review ? "review.settings_scope" : "review.defaults_scope")}</DialogDescription></DialogHeader>
      <ReviewError error={query.error || mutation.error} />
      {settings ? <div className="space-y-5">
        <div className="space-y-2"><Label>{t("review.mode")}</Label><ReviewSelect label={t("review.mode")} value={settings.mode} onChange={value => setDraft({ ...settings, mode: ReviewModeSchema.parse(value) })} options={["jev", "mixed", "llm"].map(value => ({ value, label: t(`review.${value}`) }))} /><p className="text-sm leading-relaxed text-muted-foreground">{t(`review.${settings.mode}_body`)}</p></div>
        {backends.filter(backend => settings.mode === "mixed" || settings.mode === backend).map(backend => {
          const models = query.data?.models.filter(model => model.backend === (backend === "jev" ? "systemone" : "llm")) ?? [];
          const selected = settings[backend];
          const modelOptions = models.map((model, index) => ({ value: String(index), label: `${model.name} · ${model.providerName}` }));
          const index = models.findIndex(model => model.providerId === selected?.providerId && model.model === selected?.model);
          return <div key={backend} className="space-y-2"><Label>{t(`review.${backend}_model`)}</Label><ReviewSelect label={t("review.select_model")} value={index < 0 ? "" : String(index)} options={modelOptions} onChange={value => { const model = models[Number(value)]; if (model) setDraft({ ...settings, [backend]: { providerId: model.providerId, model: model.model } }); }} />{!models.length && <p className="text-sm text-muted-foreground">{t("review.no_models")}</p>}</div>;
        })}
        <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">{t("review.ocr_hint")}</p>
      </div> : <p className="text-muted-foreground">{t("review.loading")}</p>}
      <DialogFooter><Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>{t("review.cancel")}</Button><Button onClick={() => mutation.mutate()} disabled={!settings || mutation.isPending}>{t("review.save")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
