import { Minus, Plus } from "lucide-react";
import type { EigenweltCheckoutSelection } from "@legalwork/types/eigenwelt-checkout";
import legalworkMark from "@/assets/legalwork-mark-dark.svg";
import { Button } from "@/components/ui/button";
import { EIGENWELT_PLANS, formatEuroCents, type EigenweltPlanId } from "@/app/lib/eigenwelt-plans";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

export function PlanConfirmation({ planId, selection, disabled, offerTrial, onChange, onBack, onConfirm }: {
  planId: EigenweltPlanId;
  selection: EigenweltCheckoutSelection;
  disabled: boolean;
  offerTrial: boolean;
  onChange: (selection: EigenweltCheckoutSelection) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const locale = useLocale();
  const plan = EIGENWELT_PLANS.find(plan => plan.id === planId);
  if (!plan) return null;
  const yearly = selection.interval === "year";
  const perSeat = yearly ? plan.yearlyPerMonthCents : plan.monthlyCents;
  const periodPrice = yearly ? perSeat * 12 : perSeat;
  const saving = Math.round((1 - plan.yearlyPerMonthCents / plan.monthlyCents) * 100);
  return <article data-testid="ai-plan-confirmation"
    className="mx-auto w-full rounded-2xl border border-dls-border bg-dls-surface p-5 md:w-[calc((100%-32px)/3)] xl:w-[calc((100%-40px)/3)] xl:p-6 roomy:w-[calc((100%-56px)/3)] roomy:p-7"
    style={{ viewTransitionName: `ai-plan-card-${plan.id}` }}>
    <div className="flex min-h-9 items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[26px] font-medium leading-none tracking-[-0.03em] text-dls-text roomy:gap-2.5 roomy:text-[30px]"
        style={{ viewTransitionName: `ai-plan-name-${plan.id}` }}>
        <img src={legalworkMark} alt="" className="size-6 shrink-0 roomy:size-7" />{plan.name}
      </h2>
      <button type="button" onClick={onBack} className="shrink-0 rounded-full border border-dls-border px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover">
        {t("ai_plans.confirm_change")}
      </button>
    </div>
    <div className="mt-4 roomy:mt-5">
      <div className="text-[34px] font-medium leading-none tracking-[-0.04em] text-dls-text tabular-nums roomy:text-[44px]"
        style={{ viewTransitionName: `ai-plan-price-${plan.id}` }}>{formatEuroCents(perSeat, locale)}</div>
      <p className="mt-1.5 text-[13px] leading-[18px] text-dls-secondary roomy:mt-2 roomy:text-[15px] roomy:leading-[22px]">{t("ai_plans.per_seat_month")}</p>
      <p className="mt-1 min-h-8 text-xs leading-4 text-dls-secondary">{yearly
        ? t("ai_plans.confirm_yearly_note", { amount: formatEuroCents(periodPrice, locale) })
        : t("ai_plans.confirm_monthly_note")}</p>
    </div>
    <div role="radiogroup" aria-label={t("ai_plans.confirm_interval")} className="mt-4 grid h-9 grid-cols-2 gap-1 rounded-full border border-dls-border/60 bg-muted/65 p-1">
      {(["year", "month"] satisfies EigenweltCheckoutSelection["interval"][]).map(interval => <button type="button" role="radio" aria-checked={selection.interval === interval}
        key={interval} disabled={disabled} onClick={() => onChange({ ...selection, interval })}
        className={`inline-flex items-center justify-center gap-1.5 rounded-full border py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${selection.interval === interval ? "border-dls-border/70 bg-dls-surface text-dls-text" : "border-transparent text-dls-secondary hover:text-dls-text"}`}>
        {t(interval === "year" ? "ai_plans.confirm_yearly" : "ai_plans.confirm_monthly")}{interval === "year" ? <span className="text-[11px] font-medium text-dls-secondary">{t("ai_plans.confirm_saving", { percent: saving })}</span> : null}
      </button>)}
    </div>
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-dls-border pt-4 text-dls-text">
      <span className="text-[13px] font-medium">{t("ai_plans.confirm_seats")}</span>
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" className="size-8 rounded-full" aria-label={t("ai_plans.confirm_remove_seat")} disabled={disabled || selection.seats <= 1}
          onClick={() => onChange({ ...selection, seats: selection.seats - 1 })}><Minus className="size-4" /></Button>
        <output aria-label={t("ai_plans.confirm_seats")} className="w-8 text-center text-[15px] tabular-nums">{selection.seats}</output>
        <Button size="icon" variant="outline" className="size-8 rounded-full" aria-label={t("ai_plans.confirm_add_seat")} disabled={disabled || selection.seats >= 500}
          onClick={() => onChange({ ...selection, seats: selection.seats + 1 })}><Plus className="size-4" /></Button>
      </div>
    </div>
    <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-dls-border pt-4 text-[13px] leading-[18px] text-dls-text">
      <span className="text-dls-secondary">{t("ai_plans.confirm_total")}</span>
      <strong className="font-medium tabular-nums">{formatEuroCents(periodPrice * selection.seats, locale)} / {t(yearly ? "ai_plans.confirm_year" : "ai_plans.confirm_month")}</strong>
    </div>
    <Button size="lg" className="mt-5 h-11 w-full rounded-full text-[14px] roomy:mt-6 roomy:h-12 roomy:text-[15px]" disabled={disabled} onClick={onConfirm}>{t(offerTrial ? "ai_plans.confirm_trial" : "ai_plans.confirm_continue")}</Button>
    <p className="mt-3 text-center text-[11px] leading-4 text-dls-secondary">{t("ai_plans.confirm_footnote")}</p>
  </article>;
}
