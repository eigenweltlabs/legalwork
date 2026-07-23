/** @jsxImportSource react */
import { useEffect, useState, type KeyboardEvent } from "react";
import { AudioLines, Keyboard, MousePointerClick } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AudioSystemDictationPlatform } from "@legalwork/types/audio";
import { t } from "@/i18n";

import { formatDictationShortcut } from "../../recorder/dictation-shortcut";
import { useRecorderStore } from "../../recorder/recorder-store";

function acceleratorFromEvent(
  event: KeyboardEvent<HTMLButtonElement>,
  platform: AudioSystemDictationPlatform,
): string | null {
  event.preventDefault();
  event.stopPropagation();
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push(platform === "darwin" ? "Command" : "Super");

  let key = "";
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key)) key = event.key.toUpperCase();
  else {
    const namedKeys: Record<string, string> = {
      " ": "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Backspace: "Backspace",
      Delete: "Delete",
      Enter: "Enter",
      Tab: "Tab",
    };
    key = namedKeys[event.key] ?? "";
  }
  if (!key || (modifiers.length === 0 && !key.startsWith("F"))) return null;
  return [...modifiers, key].join("+");
}

export function DictationSetupDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const store = useRecorderStore();
  const dictation = store.systemDictation;
  const [saving, setSaving] = useState(false);
  const capturing = dictation?.shortcutCaptureActive === true;

  const stopCapture = async () => {
    await store.setSystemDictationShortcutCapture(false);
  };

  useEffect(() => {
    if (props.open) return;
    if (capturing) void stopCapture();
    // Capture cleanup follows the dialog boundary, not store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && capturing) void stopCapture();
        props.onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[760px] gap-0 overflow-y-auto rounded-xl p-0 sm:max-w-[760px]">
        <DialogHeader className="items-center px-8 pb-6 pt-8 text-center">
          <DialogTitle className="text-2xl">{t("recorder.dictation_setup_title")}</DialogTitle>
          <DialogDescription className="text-base">
            {t("recorder.dictation_setup_description")}
          </DialogDescription>
        </DialogHeader>

        <section className="border-y border-subtle px-8 py-6">
          <div className="text-xs font-semibold uppercase text-subtext">
            {t("recorder.dictation_hotkey_label")}
          </div>
          <button
            type="button"
            disabled={!dictation || saving}
            className={cn(
              "mt-4 flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-lg border border-subtle bg-surface px-6 outline-none transition-colors",
              "hover:bg-sunken focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20",
              capturing && "border-brand bg-brand/5",
            )}
            onClick={() => {
              if (capturing) return;
              void store.setSystemDictationShortcutCapture(true);
            }}
            onKeyDown={(event) => {
              if (!capturing || !dictation) return;
              if (event.key === "Escape") {
                event.preventDefault();
                void stopCapture();
                return;
              }
              if (dictation.supportsHold) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              const accelerator = acceleratorFromEvent(event, dictation.platform);
              if (!accelerator) return;
              setSaving(true);
              void store
                .setSystemDictationShortcut(accelerator)
                .finally(() => stopCapture())
                .finally(() => setSaving(false));
            }}
          >
            <span className="grid min-h-14 min-w-14 place-items-center rounded-md border border-subtle bg-sunken px-3 font-mono text-lg font-medium text-ink shadow-sm">
              {dictation ? formatDictationShortcut(dictation.accelerator, dictation.platform) : <Keyboard />}
            </span>
            <span className="text-sm text-subtext">
              {saving
                ? t("recorder.dictation_hotkey_saving")
                : capturing
                  ? t("recorder.dictation_hotkey_listening")
                  : t("recorder.dictation_hotkey_change")}
            </span>
          </button>

          <div className="mt-6 flex items-center justify-between gap-4 border-t border-subtle pt-5">
            <div>
              <div className="text-xs font-semibold uppercase text-subtext">
                {t("recorder.dictation_mode_label")}
              </div>
              <div className="mt-1 text-sm text-subtext">
                {dictation?.mode === "hold"
                  ? t("recorder.dictation_mode_hold_description")
                  : dictation && !dictation.supportsHold
                    ? t("recorder.dictation_mode_hold_permission")
                    : t("recorder.dictation_mode_tap_description")}
              </div>
            </div>
            <div className="flex rounded-xl bg-sunken p-0.5">
              <button
                type="button"
                aria-pressed={dictation?.mode === "tap"}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
                  dictation?.mode === "tap" ? "bg-surface text-ink shadow-xs" : "text-subtext",
                )}
                onClick={() => void store.setSystemDictationMode("tap")}
              >
                <MousePointerClick className="size-4" />
                {t("recorder.dictation_mode_tap")}
              </button>
              <button
                type="button"
                aria-pressed={dictation?.mode === "hold"}
                title={dictation?.supportsHold ? undefined : t("recorder.dictation_mode_hold_unavailable")}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
                  dictation?.mode === "hold" ? "bg-surface text-ink shadow-xs" : "text-subtext",
                )}
                onClick={() => {
                  if (dictation?.supportsHold) void store.setSystemDictationMode("hold");
                  else void store.openSystemDictationSettings();
                }}
              >
                <AudioLines className="size-4" />
                {t("recorder.dictation_mode_hold")}
              </button>
            </div>
          </div>
        </section>

        <section className="px-8 py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs font-semibold uppercase text-subtext">
              {t("recorder.dictation_test_label")}
            </span>
            <span className="text-sm text-subtext">
              {dictation
                ? t("recorder.dictation_test_shortcut", {
                    shortcut: formatDictationShortcut(dictation.accelerator, dictation.platform),
                  })
                : ""}
            </span>
          </div>
          <Textarea
            className="mt-3 min-h-32 resize-none text-base"
            placeholder={t("recorder.dictation_test_placeholder")}
          />
        </section>
      </DialogContent>
    </Dialog>
  );
}
