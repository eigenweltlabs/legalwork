/** @jsxImportSource react */

import { useEffect } from "react";

import { windowSetStealth } from "@/app/lib/desktop";
import { setStealthThemeOverride } from "@/app/theme";
import { t } from "@/i18n";
import { useRecorderStore } from "../domains/recorder/recorder-store";

/**
 * Stealth mode — the app-wide consequence of a running local recording.
 *
 * While the Recorder is capturing, the whole window turns matte black and is
 * excluded from screen shares / recordings (main-process
 * `setContentProtection`), so nothing hints at capture during a call. This
 * replaces the old always-on-top call overlay: instead of a floating pane, the
 * app itself becomes the discreet, undetectable surface, with a single red
 * "recording locally" badge in the top-right corner.
 *
 * Mounted once at the shell root so it follows the global recorder state
 * regardless of which route (chat, settings, recorder) is on screen.
 */
export function StealthMode() {
  const recording = useRecorderStore((state) => state.recording);
  const active = Boolean(recording);

  useEffect(() => {
    const root = document.documentElement;
    if (active) root.dataset.stealth = "on";
    else delete root.dataset.stealth;

    // Pin the resolved theme to dark so every dark-keyed rule (radix scales,
    // frosted panes, sidebar) engages; [data-stealth] then re-tints to matte
    // black. Without this a light-theme app kept light text scales on the
    // black backdrop — unreadable.
    setStealthThemeOverride(active);

    // Best-effort: on plain web the bridge is absent and this no-ops.
    void Promise.resolve(windowSetStealth(active)).catch(() => {});

    return () => {
      if (active) {
        delete root.dataset.stealth;
        setStealthThemeOverride(false);
        void Promise.resolve(windowSetStealth(false)).catch(() => {});
      }
    };
  }, [active]);

  if (!active) return null;

  return (
    <div
      // Top-right, above every surface, and transparent to pointer events so it
      // never eats a window drag on the frameless titlebar.
      className="pointer-events-none fixed right-3 top-2.5 z-[200] flex items-center gap-2 rounded-full border border-red-9/40 bg-black/70 px-3 py-1.5 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-9 opacity-75" />
        <span className="relative inline-flex size-2.5 rounded-full bg-red-9" />
      </span>
      <span className="text-xs font-medium tracking-tight text-white/90">
        {t("stealth.recording_locally")}
      </span>
    </div>
  );
}
