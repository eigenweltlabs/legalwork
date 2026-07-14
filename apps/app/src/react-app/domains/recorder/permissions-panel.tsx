/** @jsxImportSource react */
/**
 * Guided OS-permission panel for the Recorder.
 *
 * Shown instead of a raw error whenever a selected capture source is blocked
 * by a missing OS permission. Each required permission gets a row with its
 * live status and the concrete action that fixes it: the native prompt for
 * the microphone, a deep link into the exact System Settings pane for
 * screen/system audio (which has no runtime prompt on macOS).
 *
 * Status auto-refreshes when the window regains focus, so returning from
 * System Settings collapses satisfied rows without any clicking around.
 */
import { useEffect } from "react";
import { Check, ExternalLink, Mic, MonitorSpeaker, RefreshCw, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { AudioPermissionKind } from "@legalwork/types/audio";

import { useRecorderStore } from "./recorder-store";

function PermissionRow({ kind }: { kind: AudioPermissionKind }) {
  const store = useRecorderStore();
  const state = store.permissions?.[kind] ?? "unknown";
  const granted = state === "granted";
  const isMac = store.permissions?.platform === "darwin";

  const label = kind === "microphone" ? t("recorder.perm_microphone") : t("recorder.perm_system_audio");
  const icon = kind === "microphone" ? <Mic /> : <MonitorSpeaker />;
  const instructions =
    kind === "microphone"
      ? t("recorder.perm_microphone_instructions")
      : isMac
        ? t("recorder.perm_system_audio_instructions_mac")
        : t("recorder.perm_system_audio_instructions");

  return (
    <div className="flex items-start gap-3 rounded-lg border border-subtle bg-sunken/60 px-3 py-2.5">
      <span className="mt-0.5 text-subtext [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {granted ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs text-success">
              <Check className="size-3" />
              {t("recorder.perm_status_granted")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning">
              <ShieldAlert className="size-3" />
              {state === "denied" || state === "restricted"
                ? t("recorder.perm_status_denied")
                : t("recorder.perm_status_not_determined")}
            </span>
          )}
        </div>
        {!granted ? <p className="mt-1 text-xs text-subtext">{instructions}</p> : null}
      </div>
      {!granted ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {kind === "microphone" && state === "not-determined" ? (
            <Button size="sm" onClick={() => void store.requestPermission("microphone")}>
              {t("recorder.perm_allow")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void store.openPermissionSettings(kind)}>
              <ExternalLink data-icon="inline-start" />
              {t("recorder.perm_open_settings")}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PermissionsPanel() {
  const store = useRecorderStore();
  const needed = store.permissionsNeeded;

  // Coming back from System Settings refocuses the window — re-check then,
  // so granted rows flip to ✓ (and the panel disappears) automatically.
  useEffect(() => {
    if (!needed.length) return;
    const onFocus = () => void store.refreshPermissions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [needed.length, store]);

  if (!needed.length) return null;

  const showDevHint = store.permissions?.platform === "darwin" && store.permissions.packaged === false;

  return (
    <div className="mt-4 rounded-xl border border-warning/40 bg-warning-soft p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldAlert className="size-4 text-warning" />
            {t("recorder.perm_title")}
          </div>
          <p className="mt-1 text-xs text-subtext">{t("recorder.perm_intro")}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("recorder.dismiss")}
          onClick={store.dismissPermissionsPanel}
        >
          <X />
        </Button>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {needed.map((kind) => (
          <PermissionRow key={kind} kind={kind} />
        ))}
      </div>
      {showDevHint ? <p className="mt-2 text-xs text-subtext">{t("recorder.perm_dev_hint")}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void store.refreshPermissions()}>
          <RefreshCw data-icon="inline-start" />
          {t("recorder.perm_check_again")}
        </Button>
        <span className="text-xs text-subtext">{t("recorder.perm_recheck_hint")}</span>
      </div>
    </div>
  );
}
