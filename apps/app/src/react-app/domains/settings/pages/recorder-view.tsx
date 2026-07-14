/** @jsxImportSource react */
/**
 * Settings → Recorder: local speech-to-text models (download, detect on
 * disk, import) and transcription defaults. The Recorder tab itself stays
 * lean — just record.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HardDrive, Keyboard, Languages, Mic, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { desktopLoginItemGet, desktopLoginItemSet } from "@/app/lib/desktop";
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
import { formatDictationShortcut } from "../../recorder/dictation-shortcut";
import { useRecorderStore } from "../../recorder/recorder-store";
import { HubTabs } from "../segmented-tabs";
import { DictationSetupDialog } from "./dictation-setup-dialog";

export function RecorderSettingsView() {
  const store = useRecorderStore();
  const [searchParams] = useSearchParams();
  // Callers deep-link the tab: "Dictate anywhere" opens ?tab=dictation, model
  // entries default to the models tab.
  const [tab, setTab] = useState<"models" | "dictation">(
    searchParams.get("tab") === "dictation" ? "dictation" : "models",
  );
  useEffect(() => {
    const requested = searchParams.get("tab");
    if (requested === "dictation" || requested === "models") setTab(requested);
  }, [searchParams]);
  const [changingDictation, setChangingDictation] = useState(false);
  const [dictationSetupOpen, setDictationSetupOpen] = useState(false);
  const [loginItem, setLoginItem] = useState<{ openAtLogin: boolean; requiresApproval: boolean } | null>(null);
  const [changingLoginItem, setChangingLoginItem] = useState(false);
  const models = store.bootstrap?.models ?? [];
  const engine = store.bootstrap?.engine;
  const selectedModelInstalled = models.some(
    (model) => model.id === store.modelId && model.state === "installed",
  );
  const dictation = store.systemDictation;

  useEffect(() => {
    void store.init();
    void desktopLoginItemGet()
      .then(setLoginItem)
      .catch(() => setLoginItem(null));
    const onFocus = () => {
      void store.refreshSystemDictation();
      void store.refreshPermissions();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // The recorder store is module-scoped and init is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setOpenAtLogin = (openAtLogin: boolean) => {
    setChangingLoginItem(true);
    void desktopLoginItemSet(openAtLogin)
      .then(setLoginItem)
      .catch(() => {})
      .finally(() => setChangingLoginItem(false));
  };

  return (
    <LayoutStack>
      <HubTabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "models", label: t("recorder.models_tab"), icon: HardDrive },
          { id: "dictation", label: t("recorder.dictation_tab"), icon: Keyboard },
        ]}
      />

      {tab === "models" ? (
        <>
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <div>
                <LayoutSectionItemTitle>{t("recorder.models_title")}</LayoutSectionItemTitle>
                <LayoutSectionItemDescription>{t("recorder.models_subtitle")}</LayoutSectionItemDescription>
              </div>
              <LayoutSectionItemHeaderActions>
                <div className="flex items-center gap-2">
                  <Languages className="size-4 text-subtext" />
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
                </div>
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
            {engine && !engine.available ? (
              <div className="rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
                {t("recorder.engine_unavailable")} {engine.error ?? ""}
              </div>
            ) : null}
            <ModelManagerList />
          </LayoutSectionItem>
        </>
      ) : (
        <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <div>
            <LayoutSectionItemTitle>{t("recorder.dictation_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("recorder.dictation_description")}
            </LayoutSectionItemDescription>
          </div>
          <LayoutSectionItemHeaderActions>
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-subtext">
                {dictation?.enabled ? t("recorder.dictation_on") : t("recorder.dictation_off")}
              </span>
              <Switch
                aria-label={t("recorder.dictation_title")}
                checked={dictation?.enabled === true}
                disabled={!dictation || changingDictation || !selectedModelInstalled}
                onCheckedChange={(checked) => {
                  setChangingDictation(true);
                  void store.setSystemDictationEnabled(checked).finally(() => setChangingDictation(false));
                }}
              />
            </div>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-medium text-ink">
              {t("recorder.dictation_shortcut_setting")}
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-subtext">
              <Keyboard className="size-4" />
              {dictation ? formatDictationShortcut(dictation.accelerator, dictation.platform) : ""}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!dictation}
            onClick={() => setDictationSetupOpen(true)}
          >
            {t("recorder.dictation_configure")}
          </Button>
        </div>

        <DictationSetupDialog open={dictationSetupOpen} onOpenChange={setDictationSetupOpen} />

        {loginItem !== null ? (
          <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-ink">
                {t("recorder.dictation_login_title")}
              </div>
              <div className="mt-1 text-sm text-subtext">
                {loginItem.requiresApproval
                  ? t("recorder.dictation_login_requires_approval")
                  : t("recorder.dictation_login_description")}
              </div>
            </div>
            <Switch
              aria-label={t("recorder.dictation_login_title")}
              checked={loginItem.openAtLogin}
              disabled={changingLoginItem}
              onCheckedChange={setOpenAtLogin}
            />
          </div>
        ) : null}

        <div className="grid gap-4 border-t border-subtle pt-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <ol className="space-y-3 text-sm text-ink">
            <li className="flex gap-3">
              <Languages className="mt-0.5 size-4 shrink-0 text-subtext" />
              <span>
                <strong className="font-medium">{t("recorder.dictation_step_model_title")}</strong>{" "}
                <span className="text-subtext">{t("recorder.dictation_step_model_body")}</span>
              </span>
            </li>
            <li className="flex gap-3">
              <Mic className="mt-0.5 size-4 shrink-0 text-subtext" />
              <span>
                <strong className="font-medium">{t("recorder.dictation_step_permission_title")}</strong>{" "}
                <span className="text-subtext">
                  {dictation?.platform === "darwin"
                    ? t("recorder.dictation_step_permission_mac")
                    : t("recorder.dictation_step_permission_windows")}
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <Keyboard className="mt-0.5 size-4 shrink-0 text-subtext" />
              <span>
                <strong className="font-medium">{t("recorder.dictation_step_use_title")}</strong>{" "}
                <span className="text-subtext">{t("recorder.dictation_step_use_body")}</span>{" "}
                {dictation?.accelerator ? (
                  <kbd className="whitespace-nowrap rounded border border-subtle bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink">
                    {formatDictationShortcut(dictation.accelerator, dictation.platform)}
                  </kbd>
                ) : null}
              </span>
            </li>
          </ol>
          <div className="flex flex-col items-start gap-2 md:items-end">
            {dictation?.platform === "darwin" ? (
              <Button variant="outline" size="sm" onClick={() => void store.openSystemDictationSettings()}>
                <ShieldCheck data-icon="inline-start" />
                {t("recorder.dictation_open_accessibility")}
              </Button>
            ) : dictation?.platform === "windows" ? (
              <Button variant="outline" size="sm" onClick={() => void store.openSystemDictationSettings()}>
                <Mic data-icon="inline-start" />
                {t("recorder.dictation_open_microphone")}
              </Button>
            ) : null}
            <span className="text-xs text-subtext">
              {!selectedModelInstalled
                ? t("recorder.dictation_model_required")
                : dictation?.registered
                  ? t("recorder.dictation_ready")
                  : dictation?.error ?? t("recorder.dictation_unavailable")}
            </span>
          </div>
        </div>
        </LayoutSectionItem>
      )}
    </LayoutStack>
  );
}
