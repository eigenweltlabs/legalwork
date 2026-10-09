import { CalendarCheck2, Check, FileText, Loader2, Timer } from "lucide-react";
import type { CalculationPresentation } from "@legalwork/types/calculation";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { calculationFacts, calculationSources, calculationSteps, cutoffText, dateText, readableText } from "./calculation-display";

export function CalculationSheet({ card, busy = false, disabled = false, error, onSource, onDecision }: {
  card: CalculationPresentation; busy?: boolean; disabled?: boolean; error?: string;
  onSource: (name: string, sources: CalculationPresentation["sources"]) => void;
  onDecision: (action: "save" | "reject" | "acknowledge") => void;
}) {
  const missing = card.runs.some(run => run.status !== "calculated");
  const closed = ["saved", "rejected", "acknowledged"].includes(card.state);
  return <section className="@container/calculation my-4 w-full max-w-[610px] overflow-hidden rounded-xl border border-border/70 bg-background text-sm" aria-label={card.title}>
    <header className="px-5 pt-5 pb-4">
      <h3 className="flex items-start gap-2.5 font-medium leading-snug"><Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" />{card.title}</h3>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{readableText(card.selection, card.runs[0]?.results[0]?.timeZone)}</p>
    </header>
    {card.runs.map(run => {
      const facts = calculationFacts(run), steps = calculationSteps(run);
      return <div key={run.id}>
        {!!facts.length && <dl className="grid grid-cols-2 gap-x-5 gap-y-3 px-5 pb-4 @[480px]/calculation:grid-cols-3">{facts.map((fact, index) => <div key={index} className="min-w-0"><dt className="text-[11px] capitalize text-muted-foreground">{fact.label}</dt><dd className="mt-1 break-words text-xs leading-relaxed">{fact.value}</dd></div>)}</dl>}
        {!!steps.length && <ol aria-label={t("calc.steps")} className="border-t border-border/70 px-5">{steps.map((step, index) => <li key={index} className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5 border-b border-border/60 py-3.5 last:border-b-0 @[480px]/calculation:grid-cols-[14px_minmax(0,1fr)_auto]">
          <span className="pt-0.5 text-[11px] text-muted-foreground">{index + 1}</span>
          <div className="min-w-0">{step.title && <p className="text-[13px] font-medium leading-snug">{step.title}</p>}<p className={step.title ? "mt-1 text-xs leading-relaxed text-muted-foreground" : "text-[13px] leading-relaxed"}>{step.reason}</p></div>
          {step.value && <p className="col-start-2 mt-1 text-xs font-medium tabular-nums @[480px]/calculation:col-start-3 @[480px]/calculation:mt-0 @[480px]/calculation:max-w-44 @[480px]/calculation:text-right">{step.value}</p>}
        </li>)}</ol>}
        {!!run.missingFacts.length && <div className="border-y border-border/70 bg-muted/30 px-5 py-4"><p className="text-sm font-medium">{t(run.status === "requires_specialist_review" ? "calc.specialist" : "calc.missing")}</p><ul className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">{run.missingFacts.map((fact, index) => <li key={index}>{readableText(fact)}</li>)}</ul><p className="mt-3 text-xs text-muted-foreground">{t("calc.no_date")}</p></div>}
        {run.results.map(result => <div key={result.calculationId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-y border-border/70 bg-muted/30 px-5 py-4">
          <p className="text-xs font-medium">{run.results.length > 1 || card.runs.length > 1 ? result.title : t("calc.result")}</p>
          <div className="ml-auto text-right"><p className="text-xl font-medium tracking-tight tabular-nums">{dateText(result.date, true)}</p><p className="mt-1 text-[11px] text-muted-foreground">{cutoffText(result)} · {result.timeZone.replace(/_/g, " ")}</p></div>
        </div>)}
      </div>;
    })}
    <footer className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{calculationSources(card.sources).map(group => <Button key={group.path} variant="ghost" size="sm" className="h-auto min-w-0 max-w-full justify-start px-0 py-1 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => onSource(group.name, group.sources)}><FileText className="size-3.5 shrink-0" /><span className="truncate">{group.name}</span><span className="shrink-0 text-[11px]">{group.sources.length > 1 ? t("calc.passages", { count: group.sources.length }) : group.sources[0].page ? t("review.page", { page: group.sources[0].page }) : ""}</span></Button>)}</div>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      {card.mode === "confirm" && <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{closed ? <span className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">{card.state === "saved" && <Check className="size-3.5" />}{t(card.state === "saved" ? "calc.saved" : card.state === "rejected" ? "calc.rejected" : "calc.acknowledged")}</span> : <>
        <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => onDecision("reject")}>{t("calc.correct")}</Button>
        <Button size="sm" disabled={disabled || busy} onClick={() => onDecision(missing ? "acknowledge" : "save")}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <CalendarCheck2 className="size-3.5" />}{t(missing ? "calc.request" : "calc.save")}</Button>
      </>}</div>}
    </footer>
  </section>;
}
