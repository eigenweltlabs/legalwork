import { Coins, ChevronDown, RotateCw } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { CostAmount, CostUsage } from "@legalwork/types/session-cost";
import { useSessionCosts } from "@/react-app/domains/session/surface/session-costs";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import { modelDisplayName } from "@/app/utils/models";

export function formatCost(value: number, currency: CostAmount["currency"], locale = "en", precise = false) {
  const minimum = precise ? 0.0001 : 0.01;
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: precise ? 4 : 2 });
  if (value > 0 && value < minimum) return `<${formatter.format(minimum)}`;
  return formatter.format(value);
}
export function costLabel(usage: Pick<CostUsage, "amounts">, locale = "en", precise = false) {
  if (!usage.amounts.length) return formatCost(0, "USD", locale, precise);
  return usage.amounts.map(amount => {
    const value = amount.cost ?? amount.knownCost;
    if (amount.cost === null && value === 0) return `${t("cost.unavailable")} (${amount.currency})`;
    const tiny = value > 0 && value < (precise ? 0.0001 : 0.01);
    return `${amount.cost === null ? `${t("cost.partial")} ` : ""}${!tiny ? "~" : ""}${formatCost(value, amount.currency, locale, precise)}`;
  }).join(" + ");
}
const hasCost = (usage: CostUsage) => usage.amounts.some(amount => amount.knownCost > 0) || usage.unpricedCalls > 0;

export function CostBreakdown({ usage, title, busy = false, conversation, background, delegated }: {
  usage: CostUsage; title: string; busy?: boolean; conversation?: CostUsage; background?: CostUsage; delegated?: CostUsage;
}) {
  const locale = currentLocale();
  const numbers = new Intl.NumberFormat(locale);
  const newInput = usage.tokens.input + usage.tokens.cache.write;
  const amounts = [{ label: title, value: usage }, ...(conversation ? [{ label: t("cost.session_title"), value: conversation }] : [])];
  const wideAmounts = amounts.some(row => row.value.amounts.length > 1 || row.value.amounts.some(amount => amount.cost === null && amount.knownCost === 0));
  return <>
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="text-xs font-medium">{t("cost.ai_estimate")}</h3>
      {busy && <span className="text-[10px] text-muted-foreground">{t("cost.so_far")}</span>}
    </div>
    <dl className={cn("grid gap-3", wideAmounts ? "grid-cols-1" : "grid-cols-2")}>
      {amounts.map(row => <div key={row.label} className="min-w-0">
        <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
        <dd className={cn("mt-1 font-medium tracking-tight tabular-nums", wideAmounts ? "text-sm" : "text-lg leading-tight")}>{costLabel(row.value, locale)}</dd>
      </div>)}
    </dl>
    <details className="group/usage border-t border-border/60 pt-2.5 text-[11px]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3 -rotate-90 transition-transform group-open/usage:rotate-0" aria-hidden />
        {t("cost.usage_details")}
      </summary>
      <div className="mt-3 space-y-2.5">
        {usage.models.length > 0 && <div className="space-y-2">
          {[...usage.models].sort((a, b) => b.calls - a.calls || (a.modelName ?? a.modelId).localeCompare(b.modelName ?? b.modelId)).map(model => {
            const name = model.modelId ? modelDisplayName(model.modelId, model.modelName) : t("cost.background");
            return <div key={`${model.providerId}/${model.modelId}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="truncate font-medium" title={name}>{name}</p>
                {model.calls > 0 && <p className="mt-0.5 text-[10px] text-muted-foreground">{t(model.calls === 1 ? "cost.calls_one" : "cost.calls_other", { count: numbers.format(model.calls) })}</p>}
              </div>
              <span className="tabular-nums text-muted-foreground">{costLabel(model, locale, true)}</span>
            </div>;
          })}
        </div>}
        <dl className="space-y-1.5 border-t border-border/60 pt-2.5">
          <div className="flex justify-between gap-3 font-medium"><dt>{t("cost.total_input")}</dt><dd className="tabular-nums">{numbers.format(newInput + usage.tokens.cache.read)}</dd></div>
          <div className="flex justify-between gap-3 pl-2 text-muted-foreground"><dt>{t("cost.new_input")}</dt><dd className="tabular-nums">{numbers.format(newInput)}</dd></div>
          <div className="flex justify-between gap-3 pl-2 text-muted-foreground"><dt>{t("cost.cache_read")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.cache.read)}</dd></div>
          <div className="flex justify-between gap-3 pt-1 font-medium"><dt>{t("cost.output")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.output)}</dd></div>
          {usage.tokens.reasoning > 0 && <div className="flex justify-between gap-3 text-muted-foreground"><dt>{t("cost.reasoning")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.reasoning)}</dd></div>}
        </dl>
        {(Boolean(delegated?.calls) || Boolean(background && hasCost(background))) && <dl className="space-y-1.5 border-t border-border/60 pt-2.5">
          {delegated && delegated.calls > 0 && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("cost.delegated")}</dt><dd className="tabular-nums">{costLabel(delegated, locale, true)}</dd></div>}
          {background && hasCost(background) && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("cost.background")}</dt><dd className="tabular-nums">{costLabel(background, locale, true)}</dd></div>}
        </dl>}
      </div>
    </details>
    {usage.pendingCalls > 0 && <p role="status" className="text-[11px] text-muted-foreground">{t("cost.settling")}</p>}
    {usage.unpricedCalls > 0 && <p role="status" className="text-[11px] text-muted-foreground">{t("cost.partial_help")}</p>}
  </>;
}

export function CostRow({ children, className, usage, conversation, busy, pending, failed, refresh }: {
  children: ReactNode; className?: string; usage?: CostUsage; conversation?: CostUsage; busy: boolean; pending: boolean; failed: boolean; refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const title = t("cost.prompt_title");
  const amount = pending ? t("cost.loading") : usage ? costLabel(usage, currentLocale()) : t("cost.unavailable");
  return <>
    <div className={className}>
      {children}
      <button type="button" aria-label={`${title}: ${amount}`} aria-expanded={open} aria-controls={detailsId}
        onClick={() => setOpen(previous => !previous)}
        className="inline-flex min-h-7 max-w-full shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/65 hover:text-foreground aria-expanded:bg-muted/65 aria-expanded:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Coins className="size-3 shrink-0 opacity-65" aria-hidden />
        <span className="min-w-0 whitespace-normal text-left tabular-nums">{amount}</span>
        <ChevronDown className={cn("size-2.5 shrink-0 opacity-50 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
    </div>
    {open && <section id={detailsId} aria-label={title} className="flex w-full max-w-xs flex-col gap-3 rounded-lg border border-border/70 bg-background p-3.5">
      {usage ? <CostBreakdown usage={usage} conversation={conversation} title={title} busy={busy} /> : <>
        <h3 className="text-sm font-medium">{title}</h3>
        {!failed && <p className="text-xs leading-relaxed text-muted-foreground">{t(pending ? "cost.loading" : "cost.partial_help")}</p>}
      </>}
      {failed && <div className="space-y-2 text-xs text-muted-foreground"><p role="status">{t("cost.load_failed")}</p>
        <button type="button" onClick={refresh} className="inline-flex items-center gap-1.5 hover:text-foreground"><RotateCw className="size-3" aria-hidden />{t("cost.retry")}</button>
      </div>}
    </section>}
  </>;
}

export function PromptCostRow({ messageIds, promptId, busy, children, className }: {
  messageIds: string[]; promptId?: string; busy: boolean; children: ReactNode; className?: string;
}) {
  const costs = useSessionCosts();
  if (!costs) return <div className={className}>{children}</div>;
  const prompt = costs.summary?.prompts.find(prompt => prompt.messageId === promptId || prompt.assistantMessageIds.some(id => messageIds.includes(id)));
  if (!prompt && busy) return <div className={className}>{children}</div>;
  return <CostRow className={className} usage={prompt} conversation={costs.summary?.total} busy={busy} pending={costs.pending} failed={costs.failed} refresh={costs.refresh}>{children}</CostRow>;
}
