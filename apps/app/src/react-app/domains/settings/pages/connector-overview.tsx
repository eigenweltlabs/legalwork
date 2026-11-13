import { useEffect, useState, type ReactNode } from "react";
import { Building2, Check, Copy, UserRound } from "lucide-react";
import { toast } from "sonner";
// Existing Eigenwelt artwork: https://eigenweltlabs.com/assets/legalwork/hero-watercolor.webp
import watercolor from "@/assets/integrations-watercolor.webp";
import { t } from "@/i18n";
import { connectorExamples, type ConnectorExampleKind } from "./connector-examples";

export function ConnectorOwnership({ team }: { team: boolean }) {
  const Icon = team ? Building2 : UserRound;
  return <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted text-foreground/80"><Icon className="size-3.5" />{t(team ? "catalog.firm_managed" : "catalog.my_own")}</span>;
}

function CopyExample({ example }: { example: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return <button type="button" aria-label={t("catalog.copy_example", { example })} onClick={async () => {
    try { await navigator.clipboard.writeText(example); setCopied(true); }
    catch { toast.error(t("catalog.copy_failed")); }
  }} className="flex items-center justify-between gap-4 rounded-2xl border border-foreground/10 bg-background/90 px-5 py-4 text-left text-sm leading-6 text-foreground shadow-xs backdrop-blur-sm transition-colors hover:border-foreground/25 hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
    <span>{example}</span><span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground" aria-live="polite">{copied ? <><Check className="size-4" />{t("config.copied")}</> : <Copy aria-hidden="true" className="size-4" />}</span>
  </button>;
}

export function ConnectorOverview({ name, description, providerId, kind, facts }: { name: string; description: string; providerId?: string; kind?: ConnectorExampleKind; facts: { label: string; value: ReactNode }[] }) {
  const browser = kind === "research" || kind === "website";
  return <>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-xl border border-border bg-muted/50 p-5 sm:grid-cols-3">
      {facts.map(fact => <div key={fact.label} className="min-w-0 space-y-1.5"><dt className="text-xs font-medium text-foreground/65">{fact.label}</dt><dd className="break-words text-sm font-semibold">{fact.value}</dd></div>)}
    </dl>
    {kind ? <>
      <section aria-label={t("catalog.examples")} className="relative isolate overflow-hidden rounded-2xl border border-border/50 px-5 py-8 sm:px-10 sm:py-12">
        <img src={watercolor} alt="" aria-hidden="true" draggable={false} className="pointer-events-none absolute inset-0 -z-10 h-full w-full scale-[1.6] object-cover opacity-90 dark:opacity-25 dark:mix-blend-screen" />
        <div className="mx-auto grid max-w-2xl gap-3">{connectorExamples(kind, name, providerId).map(example => <CopyExample key={example} example={example} />)}</div>
      </section>
      <p className="max-w-3xl text-sm leading-7 text-foreground/80">{kind === "files" ? t("catalog.files_description") : browser ? t("catalog.website_description") : description}</p>
    </> : null}
  </>;
}
