/** @jsxImportSource react */
/**
 * Settings → Recorder: local speech-to-text models (download, detect on
 * disk, import) and transcription defaults. The Recorder tab itself stays
 * lean — just record.
 */
import { Languages } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "../../../../i18n";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";
import { ModelManagerList } from "../../recorder/model-manager";
import { useRecorderStore } from "../../recorder/recorder-store";

export function RecorderSettingsView() {
  const store = useRecorderStore();
  const models = store.bootstrap?.models ?? [];
  const engine = store.bootstrap?.engine;

  return (
    <LayoutStack>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <div>
            <LayoutSectionItemTitle>{t("recorder.models_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("recorder.models_subtitle")}</LayoutSectionItemDescription>
          </div>
        </LayoutSectionItemHeader>
        {engine && !engine.available ? (
          <div className="rounded-xl border border-amber-6 bg-amber-2 px-3 py-2 text-sm text-amber-11">
            {t("recorder.engine_unavailable")} {engine.error ?? ""}
          </div>
        ) : null}
        <ModelManagerList />
      </LayoutSectionItem>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <div>
            <LayoutSectionItemTitle>{t("recorder.defaults_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("recorder.defaults_subtitle")}</LayoutSectionItemDescription>
          </div>
          <LayoutSectionItemHeaderActions>
            <div className="flex items-center gap-2">
              <Languages className="size-4 text-muted-foreground" />
              <Select
                value={store.language}
                onValueChange={(value) => {
                  if (value === "auto" || value === "en" || value === "de") store.setLanguage(value);
                }}
              >
                <SelectTrigger size="sm" className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("recorder.language_auto")}</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="de">Deutsch</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={store.modelId}
                onValueChange={(value) => {
                  if (value) store.setModelId(value);
                }}
              >
                <SelectTrigger size="sm" className="w-[220px]">
                  <SelectValue placeholder={t("recorder.model_select_placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id} disabled={model.state !== "installed"}>
                      {model.label}
                      {model.state !== "installed" ? ` (${t("recorder.model_not_installed")})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
    </LayoutStack>
  );
}
