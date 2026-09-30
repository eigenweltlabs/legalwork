import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import type { SearchSourceReference } from "@legalwork/types/search";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ArtifactFrame } from "../domains/session/artifacts/artifact-frame";
import { ImagePreview, PreviewLoading } from "../domains/session/artifacts/preview";
import { requestPanelTab } from "../domains/session/panel/panel-tab-request";
import { classifyOpenTarget } from "../domains/session/artifacts/open-target";
import { ReviewError } from "../domains/reviews/review-ui";

export function SearchSourcePanel({ client, workspaceId, sources, name, onClose }: {
  client: LegalworkServerClient; workspaceId: string; sources: SearchSourceReference[]; name: string; onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const reference = sources[Math.min(index, sources.length - 1)];
  const query = useQuery({ queryKey: ["search-source-page", workspaceId, reference], queryFn: () => client.searchSourcePage(workspaceId, reference), enabled: Boolean(reference.page), gcTime: 0 });
  const source = query.data;
  return <ArtifactFrame title={name} icon={<FileText className="size-4" />} expandable meta={reference.page ? t("review.page", { page: reference.page }) : t("review.unpaginated")} actions={<>
    <Button variant="ghost" size="icon-sm" aria-label={t("review.open_source")} onClick={() => requestPanelTab({ id: `search-document:${reference.path}`, type: "artifact", label: name, value: reference.path, preview: classifyOpenTarget(reference.path, "file"), sourcePage: reference.page ?? undefined })}><FileText className="size-4" /></Button>
    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("common.close")}><X className="size-4" /></Button>
  </>}>
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
      <span>{t("content_search.passage", { current: index + 1, total: sources.length })}{reference.source === "ocr" ? " · OCR" : ""}</span>
      <div className="flex gap-1"><Button variant="ghost" size="icon-sm" disabled={!index} aria-label={t("content_search.previous_passage")} onClick={() => setIndex(value => value - 1)}><ChevronLeft className="size-4" /></Button><Button variant="ghost" size="icon-sm" disabled={index >= sources.length - 1} aria-label={t("content_search.next_passage")} onClick={() => setIndex(value => value + 1)}><ChevronRight className="size-4" /></Button></div>
    </div>
    <blockquote className="max-h-40 shrink-0 overflow-auto border-b px-5 py-3 text-sm leading-relaxed text-muted-foreground">{reference.quote}</blockquote>
    {!reference.page ? <p className="p-5 text-sm text-muted-foreground">{t("review.unpaginated")}</p> : query.isPending ? <PreviewLoading /> : query.error ? <div className="p-4"><ReviewError error={query.error} /></div> : source && <>
      {!source.regions.length && <p className="shrink-0 px-5 py-2 text-xs text-muted-foreground">{t("review.highlight_unavailable")}</p>}
      <ImagePreview src={source.image} alt={`${name} · ${t("review.page", { page: source.page })}`} regions={source.regions} />
    </>}
  </ArtifactFrame>;
}
