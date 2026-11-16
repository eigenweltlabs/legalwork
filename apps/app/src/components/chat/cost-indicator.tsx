import { Coins, ChevronDown, RotateCw } from "lucide-react";
import type { CostUsage } from "@legalwork/types/session-cost";
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { useSessionCosts } from "@/react-app/domains/session/surface/session-costs";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";

export function formatCostUsd(value: number, locale = "en") {
  if (value > 0 && value < 0.001) return `<${new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(0.001)}`;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
}
export function costLabel(usage: Pick<CostUsage, "costUsd" | "knownCostUsd">, locale = "en") {
  if (usage.costUsd !== null) return formatCostUsd(usage.costUsd, locale);
  return usage.knownCostUsd > 0 ? `≥ ${formatCostUsd(usage.knownCostUsd, locale)}` : t("cost.unavailable");
}

export function CostBreakdown({ usage, title, busy = false, background, delegated }: {
  usage: CostUsage; title: string; busy?: boolean; background?: CostUsage; delegated?: CostUsage;
}) {
  const locale = currentLocale();
  const numbers = new Intl.NumberFormat(locale);
  const input = usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write;
  const cachePercent = input > 0 ? Math.round(usage.tokens.cache.read / input * 100) : 0;
  const buckets = [
    { label: t("cost.input"), value: usage.tokens.input },
    { label: t("cost.output"), value: usage.tokens.output },
    { label: t("cost.reasoning"), value: usage.tokens.reasoning },
    { label: t("cost.cache_read"), value: usage.tokens.cache.read },
    { label: t("cost.cache_write"), value: usage.tokens.cache.write },
  ];
  return <>
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <PopoverTitle className="text-sm font-medium">{title}</PopoverTitle>
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground">{t("cost.estimate_usd")}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("font-medium tracking-tight tabular-nums", usage.costUsd === null && usage.knownCostUsd === 0 ? "text-lg" : "text-[28px] leading-tight")}>{costLabel(usage, locale)}</span>
        {busy && <span className="text-xs text-muted-foreground">{t("cost.so_far")}</span>}
      </div>
    </div>
    <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/45 px-3 py-2.5">
      <div><p className="text-[11px] text-muted-foreground">{t("cost.model_calls")}</p><p className="mt-0.5 text-sm font-medium tabular-nums">{numbers.format(usage.calls)}</p></div>
      <div><p className="text-[11px] text-muted-foreground">{t("cost.cached_input")}</p><p className="mt-0.5 text-sm font-medium tabular-nums">{cachePercent}%</p></div>
    </div>
    {usage.models.length > 0 && <div className="space-y-3">
      {[...usage.models].sort((a, b) => b.knownCostUsd - a.knownCostUsd).map(model => <div key={`${model.providerId}/${model.modelId}`} className="flex items-center justify-between gap-4 text-xs">
        <div className="min-w-0"><p className="truncate font-medium" title={model.modelId}>{model.modelId || t("cost.background")}</p>
          {model.providerId && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{model.providerId}</p>}</div>
        <span className="shrink-0 tabular-nums text-muted-foreground">{costLabel(model, locale)}</span>
      </div>)}
    </div>}
    {(Boolean(delegated?.calls) || Boolean(background?.knownCostUsd) || Boolean(background?.unpricedCalls)) && <dl className="space-y-2 border-t border-border/70 pt-3 text-xs">
      {delegated && delegated.calls > 0 && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("cost.delegated")}</dt><dd className="tabular-nums">{costLabel(delegated, locale)}</dd></div>}
      {background && (background.knownCostUsd > 0 || background.unpricedCalls > 0) && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("cost.background")}</dt><dd className="tabular-nums">{costLabel(background, locale)}</dd></div>}
    </dl>}
    <details className="border-t border-border/70 pt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">{t("cost.token_breakdown")}</summary>
      <dl className="mt-3 space-y-2">{buckets.map(bucket => <div key={bucket.label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{bucket.label}</dt><dd className="tabular-nums">{numbers.format(bucket.value)}</dd></div>)}</dl>
    </details>
    <PopoverDescription className="border-t border-border/70 pt-3 text-[11px] leading-relaxed">
      {usage.costUsd === null ? `${t("cost.partial_help")} ` : ""}{t("cost.estimate_help")}
    </PopoverDescription>
  </>;
}

function CostIndicator({ usage, session = false, busy = false, pending = false, failed = false, refresh, background, delegated }: {
  usage?: CostUsage; session?: boolean; busy?: boolean; pending?: boolean; failed?: boolean; refresh?: () => void; background?: CostUsage; delegated?: CostUsage;
}) {
  const title = t(session ? "cost.session_title" : "cost.prompt_title");
  const amount = pending ? t("cost.loading") : usage ? costLabel(usage, currentLocale()) : t("cost.unavailable");
  return <Popover>
    <PopoverTrigger aria-label={`${title}: ${amount}`} className={cn(
      "inline-flex max-w-full items-center gap-1.5 rounded-md text-[11px] text-muted-foreground transition-colors hover:bg-muted/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      session ? "h-7 border border-border/60 bg-background/90 px-2.5 shadow-xs backdrop-blur-md" : "px-1.5 py-1 -ml-1.5",
    )}>
      <Coins className="size-3 shrink-0 opacity-65" aria-hidden />
      <span className="truncate tabular-nums">{session && usage && !pending ? `${t("cost.session")} · ` : ""}{usage?.costUsd !== null && usage && !pending ? "~" : ""}{amount}</span>
      {busy && usage && <span className="text-muted-foreground/70">{t("cost.so_far")}</span>}
      <ChevronDown className="size-2.5 shrink-0 opacity-50" aria-hidden />
    </PopoverTrigger>
    <PopoverContent align={session ? "end" : "start"} sideOffset={8} className="max-h-[min(80dvh,36rem)] w-80 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-4">
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
  return <div className="absolute right-12 top-2 z-20 max-w-[calc(100%_-_5rem)]"><CostIndicator session busy={busy} usage={costs.summary?.total} background={costs.summary?.background} delegated={costs.summary?.delegated} pending={costs.pending} failed={costs.failed} refresh={costs.refresh} /></div>;
}

export function PromptCostIndicator({ messageIds, promptId, busy }: { messageIds: string[]; promptId?: string; busy: boolean }) {
  const costs = useSessionCosts();
  if (!costs) return null;
  const prompt = costs.summary?.prompts.find(prompt => prompt.messageId === promptId || prompt.assistantMessageIds.some(id => messageIds.includes(id)));
  if (!prompt && busy) return null;
  return <div className="mt-1 w-fit"><CostIndicator usage={prompt} busy={busy} pending={costs.pending} failed={costs.failed} refresh={costs.refresh} /></div>;
}
