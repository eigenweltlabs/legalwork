import { useRequestPanelTab } from "@/react-app/domains/session/panel/panel-tab-destination";
import { getToolName, type ToolUIPart, type DynamicToolUIPart } from "ai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { CalculationCardSchema, type CalculationPresentation } from "@legalwork/types/calculation";
import { CalculationSheet } from "./calculation-sheet";
import { t } from "@/i18n";
import { useMessageList } from "../message-list-provider";

export function isCalculationTool(part: ToolUIPart | DynamicToolUIPart) { return getToolName(part) === "legalwork_calculation_present"; }
export function parseCalculationCard(output: unknown) {
  try {
    const data: unknown = typeof output === "string" ? JSON.parse(output) : output;
    const payload = data && typeof data === "object" && "referenceData" in data ? data.referenceData : data;
    const card = CalculationCardSchema.safeParse(payload);
    return card.success ? card.data.presentation : null;
  } catch { return null; }
}
export function CalculationToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  if (part.state === "output-error") return <p role="alert" className="text-sm text-destructive">{t("calc.failed")}</p>;
  if (part.state !== "output-available") return <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("calc.preparing")}</div>;
  const card = parseCalculationCard(part.output);
  return card ? <CalculationCard initial={card} /> : <p role="alert" className="text-sm text-destructive">{t("calc.failed")}</p>;
}

function CalculationCard({ initial }: { initial: Pick<CalculationPresentation, "id" | "workspaceId" | "title"> }) {
  const requestPanelTab = useRequestPanelTab();
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
  return <CalculationSheet card={card} busy={mutation.isPending} disabled={!available || query.isError}
    error={mutation.error ? t("calc.decision_failed") : query.isError ? t("calc.unavailable") : undefined}
    onDecision={action => mutation.mutate(action)}
    onSource={(name, sources) => requestPanelTab({ id: `calculation-source:${card.id}:${sources[0].path}`, type: "artifact", label: name, value: sources[0].path, preview: "pdf", searchSources: sources })} />;
}
