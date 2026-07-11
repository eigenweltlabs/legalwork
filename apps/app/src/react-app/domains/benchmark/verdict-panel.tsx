/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { BenchmarkRunItem } from "../../../app/lib/benchmark-types";
import { Spinner } from "../settings/settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemContent,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings/settings-layout";
import { criteriaScoreToneClass } from "./format";
import { useBenchmarkStore } from "./store";

export type VerdictPanelProps = {
  runId: string;
  item: BenchmarkRunItem;
};

function VerdictIcon({ verdict }: { verdict: "pass" | "fail" | "error" }) {
  if (verdict === "pass") return <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green-11" />;
  if (verdict === "fail") return <XCircle size={15} className="mt-0.5 shrink-0 text-red-11" />;
  return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-11" />;
}

export function VerdictPanel(props: VerdictPanelProps) {
  const detail = useBenchmarkStore((state) => state.itemDetails[props.item.id]);
  const loading = useBenchmarkStore((state) => state.itemDetailLoading === props.item.id);
  const loadItemDetail = useBenchmarkStore((state) => state.loadItemDetail);
  const [failedOnly, setFailedOnly] = useState(false);

  useEffect(() => {
    if (!detail) void loadItemDetail(props.runId, props.item.id);
  }, [props.runId, props.item.id, props.item.status, detail, loadItemDetail]);

  const criteriaById = new Map(detail?.task?.criteria.map((criterion) => [criterion.id, criterion]) ?? []);
  const verdicts = detail?.verdicts ?? [];
  const passed = verdicts.filter((verdict) => verdict.verdict === "pass").length;
  const total = verdicts.length;
  const hasFailures = verdicts.some((verdict) => verdict.verdict !== "pass");
  const shown = failedOnly ? verdicts.filter((verdict) => verdict.verdict !== "pass") : verdicts;

  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>
          {t("benchmark.verdicts_title")}
          {total > 0 ? (
            <span className={cn("ml-2 text-[12px] font-medium", criteriaScoreToneClass(passed, total))}>
              {t("benchmark.criteria_passed", { passed, total })}
            </span>
          ) : null}
        </LayoutSectionItemTitle>
        {hasFailures ? (
          <LayoutSectionItemHeaderActions>
            <div className="inline-flex rounded-lg border border-dls-border p-0.5 text-[12px]">
              <button
                type="button"
                className={cn(
                  "rounded-md px-2 py-0.5",
                  !failedOnly ? "bg-dls-hover font-medium text-foreground" : "text-muted-foreground",
                )}
                onClick={() => setFailedOnly(false)}
              >
                {t("benchmark.show_all")}
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-md px-2 py-0.5",
                  failedOnly ? "bg-dls-hover font-medium text-foreground" : "text-muted-foreground",
                )}
                onClick={() => setFailedOnly(true)}
              >
                {t("benchmark.show_failed")}
              </button>
            </div>
          </LayoutSectionItemHeaderActions>
        ) : null}
      </LayoutSectionItemHeader>
      <LayoutSectionItemContent>
        {loading && !detail ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Spinner />
          </div>
        ) : null}

        {shown.length ? (
          <ul className="space-y-2">
            {shown.map((verdict) => {
              const criterion = criteriaById.get(verdict.criterionId);
              return (
                <li key={verdict.criterionId} className="rounded-xl border border-dls-border p-3">
                  <div className="flex gap-2">
                    <VerdictIcon verdict={verdict.verdict} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">
                        <span className="font-mono text-[11px] text-muted-foreground">{verdict.criterionId}</span>{" "}
                        {verdict.criterionTitle}
                      </div>
                      {criterion ? (
                        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                          {criterion.matchCriteria}
                        </p>
                      ) : null}
                      {verdict.reasoning ? (
                        <div className="mt-2 rounded-lg bg-dls-hover px-2.5 py-1.5">
                          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t("benchmark.judge_label")}
                          </div>
                          <p className="text-[12px] leading-relaxed">{verdict.reasoning}</p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : detail && total > 0 ? (
          <p className="py-2 text-[13px] text-green-11">{t("benchmark.all_criteria_passed")}</p>
        ) : null}
      </LayoutSectionItemContent>
    </LayoutSectionItem>
  );
}
