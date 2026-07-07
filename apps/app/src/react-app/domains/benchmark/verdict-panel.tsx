/** @jsxImportSource react */
import { useEffect } from "react";
import { CheckCircle2, MessageSquareText, XCircle, AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { BenchmarkRunItem } from "../../../app/lib/benchmark-types";
import { SettingsNotice, Spinner } from "../settings/settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemContent,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings/settings-layout";
import { useBenchmarkStore } from "./store";

export type VerdictPanelProps = {
  runId: string;
  item: BenchmarkRunItem;
  onOpenSession?: (item: BenchmarkRunItem) => void;
};

function VerdictIcon({ verdict }: { verdict: "pass" | "fail" | "error" }) {
  if (verdict === "pass") return <CheckCircle2 size={15} className="shrink-0 text-green-11" />;
  if (verdict === "fail") return <XCircle size={15} className="shrink-0 text-red-11" />;
  return <AlertTriangle size={15} className="shrink-0 text-amber-11" />;
}

export function VerdictPanel(props: VerdictPanelProps) {
  const detail = useBenchmarkStore((state) => state.itemDetails[props.item.id]);
  const loading = useBenchmarkStore((state) => state.itemDetailLoading === props.item.id);
  const loadItemDetail = useBenchmarkStore((state) => state.loadItemDetail);

  useEffect(() => {
    if (!detail) void loadItemDetail(props.runId, props.item.id);
  }, [props.runId, props.item.id, props.item.status, detail, loadItemDetail]);

  const criteriaByid = new Map(detail?.task?.criteria.map((criterion) => [criterion.id, criterion]) ?? []);

  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>
          {t("benchmark.verdicts_title")} — {props.item.taskTitle} · {props.item.modelID}
          {props.item.sessionId && props.onOpenSession ? (
            <span className="ml-2 inline-flex align-middle">
              <Button variant="outline" size="sm" onClick={() => props.onOpenSession?.(props.item)}>
                <MessageSquareText size={13} />
                {t("benchmark.view_session")}
              </Button>
            </span>
          ) : null}
        </LayoutSectionItemTitle>
      </LayoutSectionItemHeader>
      <LayoutSectionItemContent>
        {props.item.error ? <SettingsNotice tone="error">{props.item.error}</SettingsNotice> : null}
        {loading && !detail ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Spinner />
          </div>
        ) : null}
        {detail?.verdicts.length ? (
          <ul className="space-y-3">
            {detail.verdicts.map((verdict) => {
              const criterion = criteriaByid.get(verdict.criterionId);
              return (
                <li key={verdict.criterionId} className="rounded-xl border border-dls-border p-3">
                  <div className="flex items-start gap-2">
                    <VerdictIcon verdict={verdict.verdict} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium">
                          {verdict.criterionId}: {verdict.criterionTitle}
                        </span>
                        <Badge
                          variant={verdict.verdict === "pass" ? "secondary" : verdict.verdict === "fail" ? "destructive" : "outline"}
                          className={`px-1.5 py-0 text-[10px] ${verdict.verdict === "error" ? "text-amber-11" : ""}`}
                        >
                          {verdict.verdict === "pass"
                            ? t("benchmark.verdict_pass")
                            : verdict.verdict === "fail"
                              ? t("benchmark.verdict_fail")
                              : t("benchmark.verdict_error")}
                        </Badge>
                      </div>
                      {criterion ? (
                        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                          {criterion.matchCriteria}
                        </p>
                      ) : null}
                      {verdict.reasoning ? (
                        <p className="mt-1.5 border-l-2 border-dls-border pl-2 text-[12px] leading-relaxed">
                          {verdict.reasoning}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {detail?.deliverables?.deliverables.length ? (
          <div className="mt-3">
            <div className="text-[12px] font-medium text-muted-foreground">{t("benchmark.deliverables_title")}</div>
            <ul className="mt-1 space-y-0.5 text-[12px]">
              {detail.deliverables.deliverables.map((deliverable) => (
                <li key={deliverable.name} className="flex items-center gap-2">
                  {deliverable.relativePath ? (
                    <CheckCircle2 size={12} className="text-green-11" />
                  ) : (
                    <XCircle size={12} className="text-red-11" />
                  )}
                  <span className="font-mono">{deliverable.name}</span>
                  {deliverable.size !== null ? (
                    <span className="text-muted-foreground">({deliverable.size} B)</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </LayoutSectionItemContent>
    </LayoutSectionItem>
  );
}
