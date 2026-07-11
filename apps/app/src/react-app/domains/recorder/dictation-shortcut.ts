import type { AudioSystemDictationPlatform } from "@legalwork/types/audio";

export function formatDictationShortcut(
  accelerator: string,
  platform: AudioSystemDictationPlatform,
): string {
  const parts = accelerator.split("+");
  if (platform === "darwin") {
    const symbols: Record<string, string> = {
      CommandOrControl: "⌘",
      Command: "⌘",
      Super: "⌘",
      Control: "⌃",
      Alt: "⌥",
      Shift: "⇧",
      Fn: "fn",
    };
    return parts.map((part) => symbols[part] ?? part).join("");
  }
  const labels: Record<string, string> = {
    CommandOrControl: "Ctrl",
    Command: "Ctrl",
    Control: "Ctrl",
    Super: "Windows",
    Fn: "Fn",
  };
  return parts.map((part) => labels[part] ?? part).join("+");
}
