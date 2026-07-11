/** @jsxImportSource react */
import { useEffect } from "react";
import { FileText, MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { SettingsNotice, SettingsStatusBadge, Spinner } from "../settings/settings-section";
import { LayoutSection, LayoutSectionHeader, LayoutStack } from "../settings/settings-layout";
import { resolvePathOpenTarget } from "../session/artifacts/open-target";
import { LEARNINGS_PANEL_SESSION_ID, usePanelTabStore } from "../session/panel/panel-tab-store";
import { criteriaScoreLabel, criteriaScoreToneClass, isItemActive, itemStatusBadge } from "./format";
import type { BenchmarkItemStatus } from "../../../app/lib/benchmark-types";

import { VerdictPanel } from "./verdict-panel";
import { useBenchmarkStore } from "./store";

export type ItemDetailScreenProps = {
  runId: string;
  itemId: string;
  onOpenChat: () => void;
};

/** Full page for one task×model result: judge feedback, deliverables, chat. */
export function ItemDetailScreen(props: ItemDetailScreenProps) {
  const activeRun = useBenchmarkStore((state) => state.activeRun);
  const loadRun = useBenchmarkStore((state) => state.loadRun);
  const detail = useBenchmarkStore((state) => state.itemDetails[props.itemId]);

  useEffect(() => {
    if (activeRun?.run.id !== props.runId) void loadRun(props.runId);
  }, [props.runId, activeRun?.run.id, loadRun]);

  const item = activeRun?.run.id === props.runId
    ? activeRun.items.find((entry) => entry.id === props.itemId) ?? null
    : null;

  // Deliverables open in the app's right side panel (the normal file viewer).
  const openDeliverable = (relativePath: string) => {
    const workspacePath = `.legalwork/benchmarks/${props.runId}/${props.itemId}/${relativePath}`;
    const target = resolvePathOpenTarget(workspacePath, [], "benchmark deliverable");
    if (!target) return;
    const resolved = { ...target, exists: true };
    const panelStore = usePanelTabStore.getState();
    const existing = panelStore.transcriptArtifactTargets[LEARNINGS_PANEL_SESSION_ID] ?? [];
    panelStore.syncTranscriptArtifacts(LEARNINGS_PANEL_SESSION_ID, [
      ...existing.filter((entry) => entry.id !== resolved.id),
      resolved,
    ]);
    window.dispatchEvent(new CustomEvent("legalwork-open-accessible-target", { detail: resolved }));
  };

  const deliverables = detail?.deliverables?.deliverables ?? [];

  return (
    <LayoutStack className="max-w-6xl">
      <LayoutSection>
        <LayoutSectionHeader>
          {item ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                {isItemActive(item.status) ? <Spinner /> : null}
                <SettingsStatusBadge tone={itemStatusBadge(item.status).tone} label={itemStatusBadge(item.status).label} />
              </span>
              {item.nPassed !== null && item.nCriteria !== null ? (
                <span className={`font-medium ${criteriaScoreToneClass(item.nPassed, item.nCriteria)}`}>
                  {criteriaScoreLabel(item.nPassed, item.nCriteria)}
                </span>
              ) : null}
              {typeof item.cost === "number" && item.cost > 0 ? <span>· ${item.cost.toFixed(3)}</span> : null}
            </div>
          ) : null}
        </LayoutSectionHeader>

        {item?.error ? <SettingsNotice tone="error">{item.error}</SettingsNotice> : null}

        <div className="flex flex-wrap items-center gap-2 px-1">
          {item?.sessionId ? (
            <Button variant="outline" size="sm" onClick={props.onOpenChat}>
              <MessageSquareText size={13} />
              {t("benchmark.view_session")}
            </Button>
          ) : null}
          {deliverables
            .filter((deliverable) => deliverable.relativePath)
            .map((deliverable) => (
              <Button
                key={deliverable.name}
                variant="outline"
                size="sm"
                onClick={() => openDeliverable(deliverable.relativePath!)}
              >
                <FileText size={13} />
                {deliverable.name}
              </Button>
            ))}
        </div>

        {!item && !activeRun ? (
          <div className="flex items-center justify-center py-10">
            <Spinner />
          </div>
        ) : null}

        {item && activeRun ? (
          <VerdictPanel runId={props.runId} item={item} />
        ) : null}
      </LayoutSection>
    </LayoutStack>
  );
}
