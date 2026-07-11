/** @jsxImportSource react */
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { BenchmarkModelRef, BenchmarkRunItem } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import { aggregateByTag, scoreTintClass, scoreToneClass } from "./format";

export type RunTagBreakdownProps = {
  items: BenchmarkRunItem[];
  models: BenchmarkModelRef[];
};

function modelKey(ref: { providerID: string; modelID: string }): string {
  return `${ref.providerID}/${ref.modelID}`;
}

export function RunTagBreakdown(props: RunTagBreakdownProps) {
  const rows = aggregateByTag(props.items, props.models);
  // Only meaningful once there is more than one tag to compare.
  if (rows.length < 2) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-dls-border bg-background">
      <header className="border-b border-dls-border px-5 py-3">
        <h2 className="text-[13px] font-semibold text-foreground">{t("benchmark.by_tag_title")}</h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-background px-5 py-2 text-left font-medium text-muted-foreground">
                {t("benchmark.filter_tags")}
              </th>
              {props.models.map((model) => (
                <th key={modelKey(model)} className="min-w-28 px-3 py-2 text-center font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <ProviderIcon providerId={model.providerID} size={13} />
                    <span className="truncate">{model.modelID}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.tag} className="border-t border-dls-border">
                <td className="sticky left-0 z-10 max-w-52 truncate bg-background px-5 py-2" title={row.tag}>
                  {row.tag}
                </td>
                {props.models.map((model) => {
                  const cell = row.byModel[modelKey(model)];
                  if (!cell || cell.rate === null) {
                    return (
                      <td key={modelKey(model)} className="px-3 py-2 text-center text-muted-foreground">
                        —
                      </td>
                    );
                  }
                  const pct = Math.round(cell.rate * 100);
                  return (
                    <td
                      key={modelKey(model)}
                      className={cn("px-3 py-2 text-center tabular-nums", scoreTintClass(cell.rate))}
                      title={t("benchmark.tasks_count", { count: cell.count })}
                    >
                      <span className={cn("font-medium", scoreToneClass(cell.rate))}>{pct}%</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
