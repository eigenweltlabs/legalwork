import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { useRecorderStore } from "../../recorder/recorder-store";

export function DictationMicrophoneSetting() {
  const state = useRecorderStore(store => store.dictationMicrophones);
  const refresh = useRecorderStore(store => store.refreshDictationMicrophones);
  const select = useRecorderStore(store => store.selectDictationMicrophone);
  useEffect(() => { void refresh(); }, [refresh]);

  const devices = state?.devices ?? [];
  const resolved = devices.find(device => device.id === state?.resolvedDeviceId);
  const builtIn = devices.find(device => device.builtIn && device.available);
  const missing = state && !["auto", "default"].includes(state.selection) && !resolved;
  const choices = [
    { value: "auto", label: t("recorder.dictation_mic_auto"), disabled: false },
    { value: "default", label: t("recorder.dictation_mic_default"), disabled: false },
    ...devices.map(device => ({
      value: device.id,
      label: device.name + (device.available ? "" : ` (${t("recorder.dictation_mic_unavailable")})`),
      disabled: !device.available,
    })),
  ];
  if (missing && !devices.some(device => device.id === state.selection)) {
    choices.push({ value: state.selection, label: `${state.selectedName} (${t("recorder.dictation_mic_unavailable")})`, disabled: true });
  }
  const name = state?.activeName ?? resolved?.name;

  return (
    <div className="space-y-3 border-t border-subtle pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-medium text-ink">{t("recorder.dictation_mic_title")}</div>
          <div className="mt-1 text-sm text-subtext">{t("recorder.dictation_mic_description")}</div>
        </div>
        <Select value={state?.selection ?? "auto"} items={choices}
          onValueChange={value => { if (value) void select(value); }}>
          <SelectTrigger size="sm" aria-label={t("recorder.dictation_mic_title")}
            disabled={!state} className="w-full sm:w-[280px] sm:shrink-0">
            <SelectValue className="min-w-0 truncate" />
          </SelectTrigger>
          <SelectContent>
            {choices.map(choice => <SelectItem key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {name ? <p className="text-xs text-subtext">
        {t(state?.activeName ? "recorder.dictation_mic_listening" : "recorder.dictation_mic_using", { name })}
      </p> : null}
      {missing ? <p role="alert" className="text-sm text-warning">{t("recorder.dictation_mic_missing")}</p> : null}
      {resolved?.bluetooth ? <div className="flex flex-col gap-2 rounded-xl bg-warning-soft px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-warning">{t("recorder.dictation_mic_bluetooth")}</p>
        {builtIn ? <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void select(builtIn.id); }}>
          {t("recorder.dictation_mic_use_mac")}
        </Button> : null}
      </div> : null}
    </div>
  );
}
