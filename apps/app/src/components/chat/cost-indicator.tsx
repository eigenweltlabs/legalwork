import { Coins, ChevronDown, RotateCw } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { CostAmount, CostUsage } from "@legalwork/types/session-cost";
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { useSessionCosts } from "@/react-app/domains/session/surface/session-costs";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import { modelDisplayName } from "@/app/utils/models";

export function formatCost(value: number, currency: CostAmount["currency"], locale = "en", precise = false) {
  const minimum = precise ? 0.00000001 : 0.01;
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: precise ? 8 : 2 });
  if (value > 0 && value < minimum) return `<${formatter.format(minimum)}`;
  return formatter.format(value);
}
export function costLabel(usage: Pick<CostUsage, "amounts">, locale = "en", precise = false) {
  if (!usage.amounts.length) return formatCost(0, "USD", locale, precise);
  return usage.amounts.map(amount => {
    const value = amount.cost ?? amount.knownCost;
    if (amount.cost === null && value === 0) return `${t("cost.unavailable")} (${amount.currency})`;
    const tiny = value > 0 && value < (precise ? 0.00000001 : 0.01);
    return `${amount.cost === null ? `${t("cost.partial")} ` : ""}${amount.source === "estimate" && !tiny ? "~" : ""}${formatCost(value, amount.currency, locale, precise)}`;
  }).join(" + ");
}
function costSource(usage: CostUsage) {
  return usage.amounts.map(amount => `${t(amount.source === "gateway" ? "cost.gateway" : "cost.estimate")} · ${amount.currency}`).join(" / ");
}
const hasCost = (usage: CostUsage) => usage.amounts.some(amount => amount.knownCost > 0) || usage.unpricedCalls > 0;

export function CostBreakdown({ usage, title, busy = false, conversation, background, delegated, inline = false }: {
  usage: CostUsage; title: string; busy?: boolean; conversation?: CostUsage; background?: CostUsage; delegated?: CostUsage; inline?: boolean;
}) {
  const Title = inline ? "h3" : PopoverTitle;
  const locale = currentLocale();
  const numbers = new Intl.NumberFormat(locale);
  const newInput = usage.tokens.input + usage.tokens.cache.write;
  const estimated = [usage, ...(conversation ? [conversation] : [])].some(item => item.amounts.some(amount => amount.source === "estimate"));
  return <>
    <Title className="text-sm font-medium">{t(estimated ? "cost.ai_estimate" : "cost.ai_cost")}</Title>
    <dl className="space-y-3 rounded-xl bg-muted/40 px-3 py-3 text-sm">
      {[{ label: title, value: usage }, ...(conversation ? [{ label: t("cost.session_title"), value: conversation }] : [])].map(row =>
        <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="font-medium tabular-nums">{costLabel(row.value, locale)}</dd>
        </div>)}
    </dl>
    {busy && <p className="text-[11px] text-muted-foreground">{t("cost.so_far")}</p>}
    <details className="group/usage text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3 -rotate-90 transition-transform group-open/usage:rotate-0" aria-hidden />
        {t("cost.usage_details")}
      </summary>
      <div className="mt-3 space-y-3">
        {usage.models.length > 0 && <div className="space-y-3">
          {[...usage.models].sort((a, b) => b.calls - a.calls || (a.modelName ?? a.modelId).localeCompare(b.modelName ?? b.modelId)).map(model => {
            const name = model.modelId ? modelDisplayName(model.modelId, model.modelName) : t("cost.background");
            return <div key={`${model.providerId}/${model.modelId}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="min-w-0 truncate font-medium" title={name}>{name}</p>
              <span className="tabular-nums text-muted-foreground">{costLabel(model, locale, true)}</span>
            </div>;
          })}
        </div>}
        <details className="group/advanced border-t border-border/70 pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3 -rotate-90 transition-transform group-open/advanced:rotate-0" aria-hidden />
            {t("cost.advanced_details")}
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-[10px] font-medium tracking-wide text-muted-foreground">{costSource(usage)}</p>
            <dl className="space-y-2">
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("cost.model_calls")}</dt><dd className="tabular-nums">{numbers.format(usage.calls)}</dd></div>
              <div className="flex justify-between gap-4 border-t border-border/50 pt-2 font-medium"><dt>{t("cost.total_input")}</dt><dd className="tabular-nums">{numbers.format(newInput + usage.tokens.cache.read)}</dd></div>
              <div className="flex justify-between gap-4 pl-3"><dt className="text-muted-foreground">{t("cost.new_input")}</dt><dd className="tabular-nums">{numbers.format(newInput)}</dd></div>
              <div className="flex justify-between gap-4 pl-6"><dt className="text-muted-foreground">{t("cost.cache_write")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.cache.write)}</dd></div>
              <div className="flex justify-between gap-4 pl-6"><dt className="text-muted-foreground">{t("cost.input")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.input)}</dd></div>
              <div className="flex justify-between gap-4 pl-3"><dt className="text-muted-foreground">{t("cost.cache_read")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.cache.read)}</dd></div>
              <div className="flex justify-between gap-4 border-t border-border/50 pt-2"><dt className="text-muted-foreground">{t("cost.output")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.output)}</dd></div>
              {usage.tokens.reasoning > 0 && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("cost.reasoning")}</dt><dd className="tabular-nums">{numbers.format(usage.tokens.reasoning)}</dd></div>}
            </dl>
            {(Boolean(delegated?.calls) || Boolean(background && hasCost(background))) && <dl className="space-y-2 border-t border-border/70 pt-3">
              {delegated && delegated.calls > 0 && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("cost.delegated")}</dt><dd className="tabular-nums">{costLabel(delegated, locale, true)}</dd></div>}
              {background && hasCost(background) && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("cost.background")}</dt><dd className="tabular-nums">{costLabel(background, locale, true)}</dd></div>}
            </dl>}
          </div>
        </details>
      </div>
    </details>
    {usage.pendingCalls > 0 && <p role="status" className="text-[11px] text-muted-foreground">{t("cost.settling")}</p>}
    {usage.unpricedCalls > 0 && <p role="status" className="text-[11px] text-muted-foreground">{t("cost.partial_help")}</p>}
  </>;
}

function SessionCostPopover({ usage, busy = false, pending = false, failed = false, refresh, background, delegated }: {
  usage?: CostUsage; busy?: boolean; pending?: boolean; failed?: boolean; refresh?: () => void; background?: CostUsage; delegated?: CostUsage;
}) {
  const title = t("cost.session_title");
  const amount = pending ? t("cost.loading") : usage ? costLabel(usage, currentLocale()) : t("cost.unavailable");
  return <Popover>
    <PopoverTrigger aria-label={`${title}: ${amount}`} className="inline-flex min-h-7 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/90 px-2.5 text-[11px] text-muted-foreground shadow-xs backdrop-blur-md transition-colors hover:bg-muted/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Coins className="size-3 shrink-0 opacity-65" aria-hidden />
      {usage && !pending && <span className="truncate">{t("cost.session")} ·</span>}
      <span className="min-w-0 whitespace-normal text-left tabular-nums">{amount}</span>
      {busy && usage && <span className="text-muted-foreground/70">{t("cost.so_far")}</span>}
      <ChevronDown className="size-2.5 shrink-0 opacity-50" aria-hidden />
    </PopoverTrigger>
    <PopoverContent align="end" sideOffset={8}
      className="max-h-[min(28rem,calc(100dvh-2rem))] w-80 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto overscroll-contain p-4">
      {usage ? <CostBreakdown usage={usage} title={title} busy={busy} background={background} delegated={delegated} /> : <>
        <PopoverTitle className="text-sm font-medium">{title}</PopoverTitle>
        <PopoverDescription className="text-xs leading-relaxed">{t(pending ? "cost.loading" : failed ? "cost.load_failed" : "cost.partial_help")}</PopoverDescription>
      </>}
      {failed && refresh && <div className="space-y-2"><p role="status" className="text-xs text-muted-foreground">{t("cost.load_failed")}</p><button type="button" onClick={refresh} className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"><RotateCw className="size-3" aria-hidden />{t("cost.retry")}</button></div>}
    </PopoverContent>
  </Popover>;
}

export function SessionCostIndicator({ busy }: { busy: boolean }) {
  const costs = useSessionCosts();
  if (!costs) return null;
  return <div className="absolute right-12 top-2 z-20 max-w-[calc(100%_-_5rem)]"><SessionCostPopover busy={busy} usage={costs.summary?.total} background={costs.summary?.background} delegated={costs.summary?.delegated} pending={costs.pending} failed={costs.failed} refresh={costs.refresh} /></div>;
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
    {open && <section id={detailsId} aria-label={title} className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border/70 bg-background p-4">
      {usage ? <CostBreakdown inline usage={usage} conversation={conversation} title={title} busy={busy} /> : <>
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
