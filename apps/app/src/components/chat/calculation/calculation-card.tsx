import { getToolName, type ToolUIPart, type DynamicToolUIPart } from "ai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck2, Check, FileText, Loader2, MessageSquare, Calculator } from "lucide-react";
import { CalculationCardSchema, type CalculationPresentation } from "@legalwork/types/calculation";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useMessageList } from "../message-list-provider";
import { requestPanelTab } from "@/react-app/domains/session/panel/panel-tab-request";

export function isCalculationTool(part: ToolUIPart | DynamicToolUIPart) { return getToolName(part) === "legalwork_calculation_present"; }
export function parseCalculationCard(output: unknown) {
  try {
    const data: unknown = typeof output === "string" ? JSON.parse(output) : output;
    const payload = data && typeof data === "object" && "referenceData" in data ? data.referenceData : data;
    const card = CalculationCardSchema.safeParse(payload);
    return card.success ? card.data.presentation : null;
  } catch { return null; }
}
const factNames: Record<string, string> = { triggerDate: "calc.trigger", duration: "calc.duration", unit: "calc.unit", region: "calc.location", source: "calc.evidence", court: "calc.court", rule: "calc.rule", direction: "calc.direction", timeZone: "calc.timezone" };
function label(key: string) { return factNames[key] ? t(factNames[key]) : key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "); }
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return t(value ? "calc.yes" : "calc.no");
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  if (typeof value === "object") return Object.entries(value).map(([key, value]) => `${label(key)}: ${valueText(value)}`).join(" · ");
  return String(value);
}
function Facts({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length));
  return <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">{entries.map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-xs capitalize text-muted-foreground">{label(key)}</dt><dd className="mt-0.5 break-words text-sm">{valueText(value)}</dd></div>)}</dl>;
}
function cutoffText(result: CalculationPresentation["runs"][number]["results"][number]) {
  const cutoff = new Date(result.cutoff);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: result.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(cutoff);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const nextDay = new Date(`${result.date}T00:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  if (`${fields.year}-${fields.month}-${fields.day}` === nextDay.toISOString().slice(0, 10) && fields.hour === "00" && fields.minute === "00" && fields.second === "00") return t("calc.end_of_day");
  return cutoff.toLocaleString(undefined, { timeZone: result.timeZone, dateStyle: "medium", timeStyle: "short" });
}
export function CalculationToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  if (part.state === "output-error") return <p role="alert" className="text-sm text-destructive">{t("calc.failed")}</p>;
  if (part.state !== "output-available") return <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("calc.preparing")}</div>;
  const card = parseCalculationCard(part.output);
  let error = t("calc.failed");
  if (!card) try {
    const result: unknown = typeof part.output === "string" ? JSON.parse(part.output) : part.output;
    if (result && typeof result === "object" && "ok" in result && result.ok === false) {
      if ("error" in result && typeof result.error === "string") error = result.error;
      else if ("referenceData" in result && result.referenceData && typeof result.referenceData === "object" && "message" in result.referenceData && typeof result.referenceData.message === "string") error = result.referenceData.message;
    }
  } catch { /* Keep the generic failure for a malformed/truncated response. */ }
  return card ? <CalculationCard initial={card} /> : <p role="alert" className="text-sm text-destructive">{error}</p>;
}
function CalculationCard({ initial }: { initial: Pick<CalculationPresentation, "id" | "workspaceId" | "title"> }) {
  const { legalworkClient, workspaceId, setPrompt } = useMessageList();
  const cache = useQueryClient();
  const key = ["calculation-presentation", workspaceId, initial.id];
  const available = !!legalworkClient && initial.workspaceId === workspaceId;
  const query = useQuery({ queryKey: key, queryFn: () => legalworkClient!.calculationPresentation(workspaceId, initial.id), enabled: available, refetchOnWindowFocus: true });
  const card = query.data?.presentation;
  const mutation = useMutation({ mutationFn: async (action: "save" | "reject" | "acknowledge") => {
    if (!legalworkClient || !card) throw new Error(t("calc.unavailable"));
    return legalworkClient.decideCalculation(workspaceId, card.id, action);
  }, onSuccess: async (result, action) => {
    cache.setQueryData(key, result);
    if (action === "reject") setPrompt(t("calc.feedback_prompt", { title: initial.title }));
    if (action === "acknowledge") setPrompt(t("calc.missing_prompt", { facts: result.presentation.runs.flatMap(run => run.missingFacts).join("; ") }));
    await cache.invalidateQueries({ queryKey: ["calendar"] });
  } });
  if (!card) return <section className="my-3 max-w-2xl rounded-2xl border p-5"><h3 className="text-sm font-medium">{initial.title}</h3><p role="status" className="mt-2 text-sm text-muted-foreground">{t(query.isError || !available ? "calc.unavailable" : "calc.preparing")}</p></section>;
  const missing = card.runs.some(run => run.status !== "calculated");
  const closed = ["saved", "rejected", "acknowledged"].includes(card.state);
  const sourceGroups = new Map<string, CalculationPresentation["sources"]>();
  for (const source of card.sources) {
    const key = `${source.path}:${source.hash}`;
    sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), source]);
  }
  return <section className="my-3 w-full max-w-2xl overflow-hidden rounded-2xl border bg-background" aria-label={card.title}>
    <header className="flex items-start gap-3 px-5 pt-5 pb-4"><div className="rounded-xl bg-muted/60 p-2"><Calculator className="size-4 text-muted-foreground" /></div><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{t("calc.title")}</p><h3 className="mt-0.5 text-base font-medium">{card.title}</h3></div>{card.state === "saved" && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3.5" />{t("calc.saved")}</span>}</header>
    <div className="space-y-5 px-5 pb-5">
      <div><p className="mb-1 text-xs text-muted-foreground">{t("calc.selection")}</p><p className="text-sm leading-relaxed">{card.selection}</p></div>
      {card.runs.map(run => <div key={run.id} className="space-y-4">
        <Facts values={Object.fromEntries(Object.entries(run.inputs).filter(([key, value]) => !["source", "rule"].includes(key) && !(value === false && ["supplementaryJudgment", "specialRuleOrOrder"].includes(key)) && !(key === "direction" && value === "after")))} />
        {!!run.steps.length && <ol className="space-y-3 border-t pt-4">{run.steps.map((step, index) => <li key={index} className="flex gap-3"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">{index + 1}</span><div className="min-w-0 space-y-1 text-sm">{step.title !== String(index + 1) && <p className="font-medium">{step.title}</p>}<p className="leading-relaxed">{step.reason}</p>{!!Object.keys(step.inputs).length && <p className="text-xs text-muted-foreground">{valueText(step.inputs)}</p>}{step.output !== null && step.output !== undefined && <p className="font-medium tabular-nums">{valueText(step.output)}</p>}</div></li>)}</ol>}
        {!!run.missingFacts.length && <div className="rounded-xl bg-muted/50 px-4 py-3"><p className="text-sm font-medium">{t(run.status === "requires_specialist_review" ? "calc.specialist" : "calc.missing")}</p><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{run.missingFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul><p className="mt-3 text-xs text-muted-foreground">{t("calc.no_date")}</p></div>}
        {run.results.map(result => <div key={result.calculationId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-4 py-3"><div><p className="text-xs text-muted-foreground">{card.runs.length > 1 || run.results.length > 1 ? result.title : t("calc.result")}</p><p className="mt-1 text-lg font-medium tabular-nums">{new Date(`${result.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" })}</p></div><div className="text-right text-xs text-muted-foreground"><p>{t("calc.cutoff")}</p><p className="mt-1 tabular-nums">{cutoffText(result)}</p><p>{result.timeZone}</p></div></div>)}
      </div>)}
      {!!sourceGroups.size && <div className="flex flex-wrap gap-2">{[...sourceGroups].map(([identity, sources]) => <Button key={identity} variant="outline" size="sm" className="max-w-full text-xs" onClick={() => requestPanelTab({ id: `calculation-source:${card.id}:${identity}`, type: "artifact", label: sources[0].path.split("/").at(-1)!, value: sources[0].path, preview: "pdf", searchSources: sources })}><FileText className="size-3.5 shrink-0" /><span className="truncate">{sources[0].path.split("/").at(-1)}</span><span className="text-muted-foreground">{sources.length === 1 ? t("review.page", { page: sources[0].page }) : t("calc.passages", { count: sources.length })}</span></Button>)}</div>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer select-none">{t("calc.execution")}</summary><div className="mt-3 space-y-3">{card.runs.map(run => <div key={run.id} className="space-y-2"><p className="break-all">{run.skill} · {run.version}</p><Facts values={run.inputs} /><p>{t(run.origin === "skill" ? "calc.recorded" : "calc.assessed")}</p>{run.codeHash && <p className="break-all font-mono">SHA-256 {run.codeHash}</p>}{run.sources.filter(source => /^https?:\/\//.test(source)).map(source => <a key={source} className="block break-all underline" href={source} target="_blank" rel="noreferrer">{source}</a>)}{run.code && <details><summary className="cursor-pointer">{t("calc.code")}</summary><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-[11px]">{run.code}</pre></details>}</div>)}</div></details>
      {(query.isError || mutation.error) && <p role="alert" className="text-sm text-destructive">{mutation.error instanceof Error ? mutation.error.message : t("calc.unavailable")}</p>}
    </div>
    {card.mode === "confirm" && <footer className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">{closed ? <span className="py-1 text-xs text-muted-foreground">{t(card.state === "saved" ? "calc.saved" : card.state === "rejected" ? "calc.rejected" : "calc.acknowledged")}</span> : <><Button variant="ghost" size="sm" disabled={!available || mutation.isPending || query.isError} onClick={() => mutation.mutate("reject")}><MessageSquare className="size-3.5" />{t("calc.correct")}</Button><Button size="sm" disabled={!available || mutation.isPending || query.isError} onClick={() => mutation.mutate(missing ? "acknowledge" : "save")}>{mutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CalendarCheck2 className="size-3.5" />}{t(missing ? "calc.request" : "calc.save")}</Button></>}</footer>}
  </section>;
}
