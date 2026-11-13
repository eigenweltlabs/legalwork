import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { t } from "@/i18n";
import { isTranscriptionReady, useRecorderStore } from "../recorder/recorder-store";

export type TranscriptionChoice = { source: "local" | "cloud"; modelId: string };
export type TranscriptionOption = TranscriptionChoice & { title: string; description: string; disabled?: boolean };

/** Choices stay in the setup draft until the user confirms. */
export function TranscriptionChoices(props: {
  value: TranscriptionChoice | null;
  options: TranscriptionOption[];
  onChange: (choice: TranscriptionChoice) => void;
}) {
  const key = (choice: TranscriptionChoice) => `${choice.source}:${choice.modelId}`;
  return <RadioGroup aria-label={t("onboarding_audio.transcription_title")} value={props.value ? key(props.value) : ""} onValueChange={value => {
    const option = props.options.find(item => key(item) === value);
    if (option && !option.disabled) props.onChange({ source: option.source, modelId: option.modelId });
  }}>
    {props.options.map(option => <label key={key(option)} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${props.value && key(props.value) === key(option) ? "border-foreground" : "border-dls-border"} ${option.disabled ? "cursor-not-allowed opacity-50" : ""}`}>
      <RadioGroupItem value={key(option)} disabled={option.disabled} className="mt-0.5" />
      <span>
        <span className="block text-sm font-medium">{option.title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-subtext">{option.description}</span>
      </span>
    </label>)}
  </RadioGroup>;
}

/** Called only by Continue. Selecting a card or cancelling never writes prefs. */
export async function confirmTranscriptionChoice(choice: TranscriptionChoice | null): Promise<boolean> {
  if (!choice) return false;
  const store = useRecorderStore.getState();
  if (store.recording || store.starting || store.finalizing || store.importing) return false;
  if (choice.source === "cloud") {
    if (!store.bootstrap?.cloud?.models.some(model => model.model === choice.modelId && model.enabled && model.available)) return false;
    store.setTranscriptionSource("cloud", choice.modelId);
  } else {
    const model = store.bootstrap?.models.find(model => model.id === choice.modelId);
    if (!model || store.bootstrap?.engine.available === false) return false;
    store.setModelId(choice.modelId);
    const selected = useRecorderStore.getState();
    if (selected.transcriptionSource !== "local" || selected.modelId !== choice.modelId) return false;
    if (model.state !== "installed" && model.state !== "downloading") await store.downloadModel(choice.modelId);
  }
  return isTranscriptionReady(useRecorderStore.getState());
}
