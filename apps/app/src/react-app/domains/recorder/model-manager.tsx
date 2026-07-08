/** @jsxImportSource react */
/**
 * Local speech-model management list — lives in Settings → Recorder and is
 * driven by the shared recorder store (download progress arrives over the
 * recorder event bus).
 */
import { useEffect, useState } from "react";
import { Download, FolderSearch, HardDrive, Import, Loader2, Trash2, X } from "lucide-react";

import {
  audioModelImport,
  audioModelsScanExisting,
  pickDirectory,
} from "@/app/lib/desktop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "../../../app/utils";
import { t } from "@/i18n";
import type { AudioModelDiskCandidate, AudioModelState } from "@legalwork/types/audio";

import { useRecorderStore } from "./recorder-store";

function tierLabel(tier: AudioModelState["tier"]): string {
  return t(`recorder.tier_${tier}`);
}

function ModelRow(props: { model: AudioModelState }) {
  const { model } = props;
  const store = useRecorderStore();
  const progress =
    model.totalBytes > 0 ? Math.round((model.downloadedBytes / model.totalBytes) * 100) : 0;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{model.label}</span>
          <Badge variant="outline" className="text-[10px]">{tierLabel(model.tier)}</Badge>
          <Badge variant="outline" className="text-[10px]">EN · DE</Badge>
          {model.recommended ? (
            <Badge className="text-[10px]">{t("recorder.model_recommended")}</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{model.description}</div>
        {model.state === "downloading" ? (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={progress} className="h-1.5 flex-1" />
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatBytes(model.downloadedBytes)} / {formatBytes(model.totalBytes || model.approxSizeBytes)}
            </span>
          </div>
        ) : null}
        {model.state === "error" && model.error ? (
          <div className="mt-1 text-xs text-destructive">{model.error}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatBytes(model.installedSizeBytes ?? model.approxSizeBytes)}
        </span>
        {model.state === "installed" ? (
          <>
            <Badge variant="outline" className="gap-1 text-[10px] text-green-11">
              <HardDrive className="size-3" />
              {t("recorder.model_installed")}
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("recorder.model_delete")}
              onClick={() => void store.deleteModel(model.id)}
            >
              <Trash2 />
            </Button>
          </>
        ) : model.state === "downloading" ? (
          <Button variant="outline" size="sm" onClick={() => void store.cancelModelDownload(model.id)}>
            <X data-icon="inline-start" />
            {t("recorder.model_cancel")}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void store.downloadModel(model.id)}>
            <Download data-icon="inline-start" />
            {t("recorder.model_download")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ModelManagerList() {
  const store = useRecorderStore();
  const [diskCandidates, setDiskCandidates] = useState<AudioModelDiskCandidate[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const models = store.bootstrap?.models ?? [];

  const rescan = async () => {
    try {
      setDiskCandidates(await audioModelsScanExisting());
    } catch {
      setDiskCandidates([]);
    }
  };

  useEffect(() => {
    void store.init();
    void rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const useDiskCopy = async (candidate: AudioModelDiskCandidate) => {
    setImportBusy(true);
    setImportError(null);
    const result = await audioModelImport(candidate.sourcePath, candidate.modelId);
    setImportBusy(false);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    await Promise.all([store.refreshBootstrap(), rescan()]);
  };

  const importFolder = async () => {
    const picked = await pickDirectory({ title: t("recorder.import_folder_title") });
    const folder = Array.isArray(picked) ? picked[0] : picked;
    if (!folder) return;
    setImportBusy(true);
    setImportError(null);
    const result = await audioModelImport(folder);
    setImportBusy(false);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    await Promise.all([store.refreshBootstrap(), rescan()]);
  };

  return (
    <div className="space-y-2">
      {models.map((model) => (
        <ModelRow key={model.id} model={model} />
      ))}

      {diskCandidates.length > 0 ? (
        <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <FolderSearch className="size-3.5" />
            {t("recorder.models_found_on_disk")}
          </div>
          <div className="mt-1.5 space-y-1.5">
            {diskCandidates.map((candidate) => {
              const entry = models.find((model) => model.id === candidate.modelId);
              return (
                <div key={`${candidate.modelId}-${candidate.sourcePath}`} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-foreground">{entry?.label ?? candidate.modelId}</span>
                    <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                      {formatBytes(candidate.sizeBytes)}
                    </span>
                    <div className="truncate text-[11px] text-muted-foreground">{candidate.sourcePath}</div>
                  </div>
                  <Button size="sm" variant="outline" disabled={importBusy} onClick={() => void useDiskCopy(candidate)}>
                    {importBusy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Import data-icon="inline-start" />}
                    {t("recorder.model_use_local")}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-xs text-muted-foreground">{t("recorder.import_folder_hint")}</span>
        <Button size="sm" variant="outline" disabled={importBusy} onClick={() => void importFolder()}>
          <Import data-icon="inline-start" />
          {t("recorder.import_folder")}
        </Button>
      </div>
      {importError ? <div className="text-xs text-destructive">{importError}</div> : null}
    </div>
  );
}
