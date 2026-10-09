import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, X } from "lucide-react";
import type { ReviewSourceReference } from "@legalwork/types/reviews";
import type { DocumentRegion, DocumentTable, PageStructure } from "@legalwork/types/document-structure";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ArtifactFrame } from "../session/artifacts/artifact-frame";
import { ImagePreview, PreviewLoading } from "../session/artifacts/preview";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { classifyOpenTarget } from "../session/artifacts/open-target";
import { ReviewError } from "./review-ui";

export function regionKindLabel(kind: DocumentRegion["kind"]) {
  switch (kind) {
    case "text": return t("review.region_text");
    case "heading": return t("review.region_heading");
    case "list": return t("review.region_list");
    case "table": return t("review.region_table");
    case "figure": return t("review.region_figure");
    case "caption": return t("review.region_caption");
    case "header": return t("review.region_header");
    case "footer": return t("review.region_footer");
    case "footnote": return t("review.region_footnote");
    case "formula": return t("review.region_formula");
    case "note": return t("review.region_note");
    case "unknown": return t("review.region_unknown");
  }
}

/** Regions in reading order, then any others; at most 500. */
export function orderedRegions(structure: PageStructure | undefined) {
  if (!structure) return [];
  const byId = new Map(structure.regions.map(region => [region.id, region]));
  const seen = new Set<string>();
  const ordered: DocumentRegion[] = [];
  for (const id of structure.readingOrder) {
    const region = byId.get(id);
    if (region && !seen.has(id)) { ordered.push(region); seen.add(id); }
  }
  for (const region of structure.regions) if (!seen.has(region.id)) ordered.push(region);
  return ordered.slice(0, 500);
}

export function TableCells({ table }: { table: DocumentTable }) {
  return <div className="max-h-48 shrink-0 overflow-auto border-b px-4 py-2 text-xs">
    <p className="mb-2 font-medium">{t("review.region_table")}{table.status === "uncertain" ? ` · ${t("review.inferred_table_cells")}` : ""}</p>
    {table.cells.length > 0 && table.columns > 0 && table.columns <= 20 && table.rows <= 100 ? <div className="grid gap-px bg-border" style={{ gridTemplateColumns: `repeat(${table.columns}, minmax(0, 1fr))` }}>
      {table.cells.slice(0, 200).map(cell => <div key={cell.id} className="min-w-0 bg-background p-1" style={{ gridColumn: `${cell.column + 1} / span ${cell.columnSpan}`, gridRow: `${cell.row + 1} / span ${cell.rowSpan}` }}>{cell.text.slice(0, 300)}</div>)}
    </div> : <p className="text-muted-foreground">{t("review.table_grid_unavailable")}</p>}
  </div>;
}

export function ReviewSourcePanel({ client, workspaceId, citation, name, onClose }: {
  client: LegalworkServerClient; workspaceId: string; citation: ReviewSourceReference; name: string; onClose: () => void;
}) {
  const requestPanelTab = useRequestPanelTab();
  const [page, setPage] = useState<number>();
  const [layout, setLayout] = useState(false);
  const [selectedRegionId, setSelectedRegionId] = useState<string>();
  useEffect(() => { setPage(undefined); setLayout(false); setSelectedRegionId(undefined); }, [workspaceId, citation.reviewId, citation.documentId, citation.columnKey, citation.citationIndex, citation.completedAt]);
  const query = useQuery({ queryKey: ["review-source-page", workspaceId, citation, page], queryFn: () => client.reviewCitationPage(workspaceId, citation, page), gcTime: 0 });
  const source = query.data;
  const visibleRegions = useMemo(() => orderedRegions(source?.structure), [source?.structure]);
  const selectedRegion = source?.structure?.regions.find(region => region.id === selectedRegionId);
  const selectedTable = source?.structure?.tables.find(table => table.regionId === selectedRegionId);
  return <ArtifactFrame title={name} icon={<FileText className="size-4" />} expandable meta={source ? t("review.page", { page: source.page }) : undefined} actions={<>
    {source && <Button variant="ghost" size="icon-sm" aria-label={t("review.open_source")} onClick={() => requestPanelTab({ id: `review-document:${citation.reviewId}:${citation.documentId}`, type: "artifact", label: name, value: source.path, preview: classifyOpenTarget(source.path, "file"), sourcePage: source.page })}><FileText className="size-4" /></Button>}
    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("review.close")}><X className="size-4" /></Button>
  </>}>
    {query.isPending ? <PreviewLoading /> : query.error ? <div className="p-4"><ReviewError error={query.error} /></div> : source && <>
      {source.quote && <blockquote className="max-h-36 shrink-0 overflow-auto border-b px-5 py-3 text-sm leading-relaxed text-muted-foreground">{source.quote}</blockquote>}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        {page !== undefined && <Button variant="outline" size="sm" onClick={() => { setPage(undefined); setSelectedRegionId(undefined); }}>{t("review.return_to_citation")}</Button>}
        {source.structure && <Button variant="choice" size="sm" aria-pressed={layout} onClick={() => { setLayout(!layout); setSelectedRegionId(undefined); }}>{t("review.layout")}</Button>}
        {source.structure?.status === "partial" && <span className="text-xs text-muted-foreground">{t("review.layout_partial")}</span>}
        {source.structure?.status === "unavailable" && <span className="text-xs text-muted-foreground">{t("review.layout_unavailable")}</span>}
      </div>
      {layout && source.structure && <div className="max-h-44 shrink-0 overflow-auto border-b px-4 py-2" aria-label={t("review.layout_regions")}>
        {visibleRegions.length ? <ol className="space-y-2">{visibleRegions.map(region => <li key={region.id} className="text-xs leading-relaxed">
          <button type="button" aria-pressed={selectedRegionId === region.id} className="w-full rounded px-2 py-1 text-left hover:bg-muted aria-pressed:bg-muted" onClick={() => setSelectedRegionId(selectedRegionId === region.id ? undefined : region.id)}>
            <span className="font-medium">{regionKindLabel(region.kind)}</span>{region.text && <span className="ml-2 text-muted-foreground">{region.text.slice(0, 500)}</span>}
          </button>
        </li>)}</ol> : <p className="text-xs text-muted-foreground">{t("review.no_layout_regions")}</p>}
        {source.structure.regions.length > visibleRegions.length && <p className="pt-2 text-xs text-muted-foreground">{t("review.layout_region_limit", { count: visibleRegions.length })}</p>}
      </div>}
      {layout && selectedTable && <TableCells table={selectedTable} />}
      {source.relatedPassages && source.relatedPassages.length > 0 && <div className="max-h-36 shrink-0 overflow-auto border-b px-4 py-2" aria-label={t("review.related_passages")}>
        <p className="mb-1 text-xs font-medium">{t("review.related_passages")}</p>
        <ul className="space-y-1">{source.relatedPassages.map(item => <li key={item.relation.id}>
          <button type="button" className="w-full rounded px-2 py-1 text-left text-xs hover:bg-muted" onClick={() => { setSelectedRegionId(item.region.id); setLayout(true); setPage(item.page); }}>
            <span className="font-medium">{t("review.page", { page: item.page })} · {regionKindLabel(item.region.kind)}{item.relation.status === "candidate" ? ` · ${t("review.candidate")}` : ""}</span>
            {item.region.text && <span className="block truncate text-muted-foreground">{item.region.text}</span>}
            <span className="block truncate text-muted-foreground">{item.relation.explanation}</span>
          </button>
        </li>)}</ul>
      </div>}
      {!layout && source.quote && !source.regions.length && <p className="shrink-0 px-5 py-2 text-xs text-muted-foreground">{t("review.highlight_unavailable")}</p>}
      <ImagePreview src={source.image} alt={`${source.name} · ${t("review.page", { page: source.page })}`} regions={layout && selectedRegion ? [selectedRegion.box] : layout && source.structure ? visibleRegions.map(region => region.box) : source.regions} />
    </>}
  </ArtifactFrame>;
}
