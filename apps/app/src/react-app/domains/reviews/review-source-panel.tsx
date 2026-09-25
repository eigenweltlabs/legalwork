import { useQuery } from "@tanstack/react-query";
import { FileText, X } from "lucide-react";
import type { ReviewSourceReference } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ArtifactFrame } from "../session/artifacts/artifact-frame";
import { ImagePreview, PreviewLoading } from "../session/artifacts/preview";
import { requestPanelTab } from "../session/panel/panel-tab-request";
import { classifyOpenTarget } from "../session/artifacts/open-target";
import { ReviewError } from "./review-ui";

export function ReviewSourcePanel({ client, workspaceId, citation, name, onClose }: {
  client: LegalworkServerClient; workspaceId: string; citation: ReviewSourceReference; name: string; onClose: () => void;
}) {
  const query = useQuery({ queryKey: ["review-source-page", workspaceId, citation], queryFn: () => client.reviewCitationPage(workspaceId, citation), gcTime: 0 });
  const source = query.data;
  return <ArtifactFrame title={name} icon={<FileText className="size-4" />} expandable meta={source ? t("review.page", { page: source.page }) : undefined} actions={<>
    {source && <Button variant="ghost" size="icon-sm" aria-label={t("review.open_source")} onClick={() => requestPanelTab({ id: `review-document:${citation.reviewId}:${citation.documentId}`, type: "artifact", label: name, value: source.path, preview: classifyOpenTarget(source.path, "file"), sourcePage: source.page })}><FileText className="size-4" /></Button>}
    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("review.close")}><X className="size-4" /></Button>
  </>}>
    {query.isPending ? <PreviewLoading /> : query.error ? <div className="p-4"><ReviewError error={query.error} /></div> : source && <>
      <blockquote className="max-h-36 shrink-0 overflow-auto border-b px-5 py-3 text-sm leading-relaxed text-muted-foreground">{source.quote}</blockquote>
      {!source.regions.length && <p className="shrink-0 px-5 py-2 text-xs text-muted-foreground">{t("review.highlight_unavailable")}</p>}
      <ImagePreview src={source.image} alt={`${source.name} · ${t("review.page", { page: source.page })}`} regions={source.regions} />
    </>}
  </ArtifactFrame>;
}
