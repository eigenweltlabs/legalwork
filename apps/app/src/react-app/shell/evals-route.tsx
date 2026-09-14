/** @jsxImportSource react */

import { useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBenchmarkStore } from "../domains/benchmark/store";
import { SettingsSurface } from "./settings-route";
import { t } from "@/i18n";

/**
 * Evals main pane. Rendered inside the session shell's `SidebarInset`
 * (via SessionPage's `mainView`), so the main app sidebar stays in place.
 *
 * The pane is the Benchmark surface and nothing else — embedded through the
 * same singleView SettingsSurface mechanism the Workflows and Integrations
 * pages use.
 */

export type EvalsPaneProps = {
  workspaceId?: string;
};

export function EvalsPane(props: EvalsPaneProps) {
  const [benchmarkPath, setBenchmarkPath] = useState("benchmark");
  const benchmarkNavigateRef = useRef<((path: string) => void) | null>(null);

  const benchmarkTasks = useBenchmarkStore((state) => state.tasks);
  const benchmarkRuns = useBenchmarkStore((state) => state.runs);
  const activeRun = useBenchmarkStore((state) => state.activeRun);

  // One back affordance, always in the same spot: its label and target follow
  // the current depth, and the current screen's title sits next to it. The
  // benchmark root is the top of this pane, so it carries no breadcrumb.
  const back = (() => {
    const segments = benchmarkPath.split("/");
    if (segments[1] === "tasks" && segments[2]) {
      const taskId = decodeURIComponent(segments[2]);
      return {
        label: t("evals.tasks"),
        action: () => benchmarkNavigateRef.current?.("benchmark"),
        title: benchmarkTasks.find((task) => task.id === taskId)?.title ?? null,
      };
    }
    if (segments[1] === "runs" && segments[2] && segments[3] === "items" && segments[4]) {
      const runPath = `benchmark/runs/${segments[2]}`;
      const itemPath = `${runPath}/items/${segments[4]}`;
      const itemId = decodeURIComponent(segments[4]);
      const item = activeRun?.items.find((entry) => entry.id === itemId) ?? null;
      const itemTitle = item ? `${item.taskTitle} · ${item.modelID}` : null;
      if (segments[5] === "chat") {
        return {
          label: t("evals.details"),
          action: () => benchmarkNavigateRef.current?.(itemPath),
          title: itemTitle ? `${itemTitle} — Chat` : "Chat",
        };
      }
      return {
        label: t("evals.run"),
        action: () => benchmarkNavigateRef.current?.(runPath),
        title: itemTitle,
      };
    }
    if (segments[1] === "runs" && segments[2]) {
      const runId = decodeURIComponent(segments[2]);
      return {
        label: t("evals.runs"),
        action: () => benchmarkNavigateRef.current?.("benchmark"),
        title:
          activeRun?.run.id === runId
            ? activeRun.run.title
            : benchmarkRuns.find((run) => run.id === runId)?.title ?? null,
      };
    }
    return null;
  })();

  return (
    <div className="flex h-full w-full flex-col">
      {back ? (
        <div className="flex min-w-0 items-center gap-2 px-4 pt-3">
          <Button variant="ghost" size="sm" onClick={back.action}>
            <ArrowLeft size={14} />
            {back.label}
          </Button>
          {back.title ? (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="truncate text-sm font-medium text-foreground">{back.title}</span>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <SettingsSurface
          embedded
          singleView
          initialPath="benchmark"
          workspaceId={props.workspaceId}
          onEmbeddedPathChange={setBenchmarkPath}
          embeddedNavigateRef={benchmarkNavigateRef}
        />
      </div>
    </div>
  );
}
