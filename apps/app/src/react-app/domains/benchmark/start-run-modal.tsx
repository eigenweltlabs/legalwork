/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import type { ProviderListItem } from "../../../app/types";
import { SettingsNotice } from "../settings/settings-section";
import { ArmSelectStep } from "./arm-select";
import { buildModelOptions, defaultJudgeOption, ModelSelectStep } from "./model-select";
import { getBenchmarkContext, useBenchmarkStore } from "./store";

/** Evaluations (tasks × models) at/above which a run runs long enough locally to warrant a heads-up. */
const LARGE_RUN_THRESHOLD = 100;

export type StartRunModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  onRunCreated: (runId: string) => void;
};

export function StartRunModal(props: StartRunModalProps) {
  const selectedTaskIds = useBenchmarkStore((state) => state.selectedTaskIds);
  const draft = useBenchmarkStore((state) => state.draft);
  const creating = useBenchmarkStore((state) => state.creating);
  const createError = useBenchmarkStore((state) => state.createError);
  const toggleModel = useBenchmarkStore((state) => state.toggleModel);
  const setJudge = useBenchmarkStore((state) => state.setJudge);
  const setDraftName = useBenchmarkStore((state) => state.setDraftName);
  const setDraftArms = useBenchmarkStore((state) => state.setDraftArms);
  const resetDraft = useBenchmarkStore((state) => state.resetDraft);
  const createRun = useBenchmarkStore((state) => state.createRun);

  useEffect(() => {
    if (props.open) resetDraft();
  }, [props.open, resetDraft]);

  // Arms multiply the grid: every arm re-runs every task on every model.
  const evaluations =
    selectedTaskIds.length * Math.max(draft.models.length, 1) * Math.max(draft.arms.length, 1);
  const isLargeRun = evaluations >= LARGE_RUN_THRESHOLD;

  // Ablation pickers need to know what this workspace actually has installed.
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [skills, setSkills] = useState<Array<{ name: string; kind: "skill" | "workflow" }>>([]);
  useEffect(() => {
    if (!props.open) return;
    const ctx = getBenchmarkContext();
    if (!ctx) return;
    let cancelled = false;
    void (async () => {
      const [ids, skillList] = await Promise.all([
        ctx.client.benchmarkToolIds(ctx.workspaceId).catch(() => ({ items: [] as string[] })),
        ctx.client.listSkills(ctx.workspaceId, { includeGlobal: true }).catch(() => ({ items: [] })),
      ]);
      if (cancelled) return;
      setToolIds(ids.items ?? []);
      setSkills(
        (skillList.items ?? []).map((item) => ({
          name: item.name,
          kind: item.kind === "workflow" ? ("workflow" as const) : ("skill" as const),
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  // Judge defaults to deepseek-v4-flash (or closest available) once models load.
  const modelOptions = useMemo(
    () => buildModelOptions(props.providers, props.providerConnectedIds),
    [props.providers, props.providerConnectedIds],
  );
  useEffect(() => {
    if (!props.open || draft.judge || !modelOptions.length) return;
    const fallback = defaultJudgeOption(modelOptions);
    if (fallback) setJudge({ providerID: fallback.providerID, modelID: fallback.modelID });
  }, [props.open, draft.judge, modelOptions, setJudge]);

  const start = async () => {
    const run = await createRun();
    if (run) props.onRunCreated(run.id as unknown as string);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {t("benchmark.new_run")} — {t("benchmark.selected_count", { count: selectedTaskIds.length })}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label className="text-[12px]">{t("benchmark.run_name_label")}</Label>
            <Input
              className="max-w-sm"
              value={draft.name}
              placeholder={`Eval ${new Date().toLocaleDateString()}`}
              onChange={(event) => setDraftName(event.target.value)}
            />
          </div>

          <ModelSelectStep
            providers={props.providers}
            providerConnectedIds={props.providerConnectedIds}
            selectedModels={draft.models}
            judge={draft.judge}
            onToggleModel={toggleModel}
            onSetJudge={setJudge}
          />

          <ArmSelectStep arms={draft.arms} toolIds={toolIds} skills={skills} onChange={setDraftArms} />

          <div className="text-[12px] text-muted-foreground">
            {t("benchmark.evaluations", { count: evaluations })}
            {draft.arms.length > 1 ? (
              <span className="ml-1">
                ({selectedTaskIds.length} tasks × {draft.models.length || 1} models × {draft.arms.length} arms)
              </span>
            ) : null}
          </div>

          {createError ? (
            <SettingsNotice tone="error">
              {t("benchmark.error_create_run", { message: createError })}
            </SettingsNotice>
          ) : null}
        </div>

        <DialogFooter className="items-center">
          {isLargeRun ? (
            <span className="mr-auto max-w-md text-left text-[11px] leading-snug text-amber-11">
              {t("benchmark.large_run_warning", { count: evaluations })}
            </span>
          ) : null}
          <Button
            onClick={() => void start()}
            disabled={creating || !selectedTaskIds.length || !draft.models.length}
          >
            {creating ? t("benchmark.starting") : t("benchmark.start_run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
