import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ScanText, X } from "lucide-react";
import type { ReviewRecognitionPage } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ArtifactFrame } from "../session/artifacts/artifact-frame";
import { ImagePreview, PreviewLoading } from "../session/artifacts/preview";
import type { ArtifactPanelTab } from "../session/panel/panel-tab-store";
import { ReviewError } from "./review-ui";
import { orderedRegions, regionKindLabel, TableCells } from "./review-source-panel";

const statusLabels: Record<ReviewRecognitionPage["pages"][number]["status"], string> = {
  complete: "review.page_recognized", "needs-review": "review.needs_review", error: "review.page_unreadable", missing: "review.page_not_prepared",
};
const reasonLabels: Record<string, string> = {
  "no-text": "review.reason_no_text", "output-dropped": "review.reason_output_dropped", illegible: "review.reason_illegible",
  "low-confidence": "review.reason_low_confidence", "layout-unavailable": "review.reason_layout_unavailable",
  "layout-regions-unavailable": "review.reason_no_blocks", "region-text-truncated": "review.reason_text_shortened",
};

/** Every page of a review document as recognized: its text blocks, their outlines and why a page needs review. */
export function ReviewRecognitionPanel({ client, workspaceId, reference, name, onClose }: {
  client: LegalworkServerClient; workspaceId: string; reference: NonNullable<ArtifactPanelTab["reviewRecognition"]>; name: string; onClose: () => void;
}) {
  const [page, setPage] = useState(reference.page);
  const [selectedRegionId, setSelectedRegionId] = useState<string>();
  useEffect(() => { setPage(reference.page); setSelectedRegionId(undefined); }, [workspaceId, reference.reviewId, reference.documentId, reference.page]);
  const query = useQuery({
    queryKey: ["review-recognition-page", workspaceId, reference.reviewId, reference.documentId, page],
    queryFn: () => client.reviewRecognitionPage(workspaceId, reference.reviewId, reference.documentId, page),
    placeholderData: keepPreviousData, gcTime: 0,
  });
  const data = query.data;
  const regions = useMemo(() => orderedRegions(data?.structure), [data?.structure]);
  const current = data?.pages[data.page - 1];
  const flagged = data?.pages.filter(item => item.status !== "complete") ?? [];
  const nextFlagged = data && (flagged.find(item => item.page > data.page) ?? flagged.find(item => item.page !== data.page));
  const selected = data?.structure?.regions.find(region => region.id === selectedRegionId);
  const table = data?.structure?.tables.find(item => item.regionId === selectedRegionId);
  const go = (next: number) => { setPage(next); setSelectedRegionId(undefined); };
  return <ArtifactFrame title={name} icon={<ScanText className="size-4" />} expandable meta={data?.engine} actions={<Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("review.close")}><X className="size-4" /></Button>}>
    {query.isPending ? <PreviewLoading /> : query.error ? <div className="p-4"><ReviewError error={query.error} /></div> : data && current && <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="icon-sm" aria-label={t("review.previous_page")} disabled={query.isFetching || data.page <= 1} onClick={() => go(data.page - 1)}><ChevronLeft className="size-4" /></Button>
        <span className="text-xs tabular-nums">{t("review.page_of", { page: data.page, count: data.pageCount })}</span>
        <Button variant="ghost" size="icon-sm" aria-label={t("review.next_page")} disabled={query.isFetching || data.page >= data.pageCount} onClick={() => go(data.page + 1)}><ChevronRight className="size-4" /></Button>
        <span className={cn("text-xs", current.status === "complete" ? "text-muted-foreground" : "text-warning")}>{t(statusLabels[current.status])}</span>
        {nextFlagged && <Button variant="outline" size="sm" className="ml-auto" disabled={query.isFetching} onClick={() => go(nextFlagged.page)}>{t("review.next_flagged", { count: flagged.length })}</Button>}
      </div>
      {(current.reasons.length > 0 || data.error) && <ul className="shrink-0 list-disc space-y-1 border-b py-2 pl-9 pr-5 text-xs text-warning">
        {data.error && <li>{data.error}</li>}
        {current.reasons.map(reason => <li key={reason}>{reasonLabels[reason] ? t(reasonLabels[reason]) : t("review.reason_other", { reason })}</li>)}
      </ul>}
      <div className="max-h-[40%] shrink-0 overflow-auto border-b px-4 py-2" aria-label={t("review.recognized_text")}>
        {regions.length ? <ol className="space-y-1">{regions.map(region => <li key={region.id}>
          <button type="button" aria-pressed={selectedRegionId === region.id} className="w-full rounded px-2 py-1 text-left text-xs leading-relaxed hover:bg-muted aria-pressed:bg-muted" onClick={() => setSelectedRegionId(selectedRegionId === region.id ? undefined : region.id)}>
            <span className="font-medium">{regionKindLabel(region.kind)}</span>
            {region.text && <span className="block whitespace-pre-wrap text-muted-foreground">{region.text}</span>}
          </button>
        </li>)}</ol> : data.text ? <p className="whitespace-pre-wrap text-xs leading-relaxed">{data.text}</p> : <p className="text-xs text-muted-foreground">{t("review.reason_no_text")}</p>}
      </div>
      {table && <TableCells table={table} />}
      <ImagePreview src={data.image} alt={`${data.name} · ${t("review.page", { page: data.page })}`} regions={selected ? [selected.box] : regions.map(region => region.box)} />
    </>}
  </ArtifactFrame>;
}
