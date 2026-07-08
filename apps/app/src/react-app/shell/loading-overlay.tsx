/** @jsxImportSource react */
import { useState } from "react";

import { supportBundleCollect } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { useBootState, useBootOverlayVisible } from "./boot-state";
import { OwDotTicker } from "./dot-ticker";

const RELEASES_URL = "https://github.com/eigenweltlabs/legalwork/releases";

/**
 * One-click support-log collection for the boot error screen. The customer
 * whose local server never starts is stuck exactly here, so this is the one
 * place a "get me the logs" affordance must exist inside the UI (the native
 * Help menu carries the same action for every other situation).
 */
function CollectLogsButton() {
  const [state, setState] = useState<
    { status: "idle" | "collecting" | "failed" } | { status: "done"; path: string }
  >({ status: "idle" });

  const collect = async () => {
    setState({ status: "collecting" });
    try {
      const result = (await supportBundleCollect()) as { path?: string | null };
      if (!result?.path) {
        // User canceled the save dialog — quietly return to the idle button.
        setState({ status: "idle" });
        return;
      }
      setState({ status: "done", path: result.path });
    } catch (error) {
      console.error("[boot-overlay] support bundle collection failed:", error);
      setState({ status: "failed" });
    }
  };

  if (state.status === "done") {
    return (
      <div className="text-[11px] leading-4 text-dls-secondary">
        Log file saved to {state.path}. Please send it to support.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => void collect()}
        disabled={state.status === "collecting"}
        className="rounded-md border border-dls-border px-3 py-1.5 text-[12px] leading-5 text-dls-text hover:bg-dls-hover disabled:opacity-60"
      >
        {state.status === "collecting" ? "Collecting logs..." : "Collect logs for support"}
      </button>
      {state.status === "failed" ? (
        <div className="text-[11px] leading-4 text-dls-secondary">
          Could not collect logs. Try Help &gt; Collect Support Logs...
        </div>
      ) : null}
    </div>
  );
}

/**
 * Quiet, opaque boot overlay. Solid surface fill so nothing bleeds through.
 * A minimal typographic beat plus a small dot ticker. Fades once both the
 * boot hook and the first route load are ready.
 */
export function LoadingOverlay() {
  const visible = useBootOverlayVisible();
  const { phase, message, error } = useBootState();

  if (!visible) return null;

  const fading = phase === "ready";

  return (
    <div
      className={`fixed inset-0 z-[1000] flex items-center justify-center bg-dls-surface transition-opacity duration-[160ms] ${
        fading ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!fading}
      role="status"
    >
      <div className="flex w-full max-w-[320px] flex-col items-center gap-4 px-6 text-center">
        <OwDotTicker size="md" />
        <div className="text-[12px] leading-5 text-dls-secondary">
          {message || "Preparing workspace"}
        </div>
        {error ? (
          <div className="flex flex-col items-center gap-3 text-[12px] leading-5 text-red-11">
            <div>{error}</div>
            {isDesktopRuntime() ? <CollectLogsButton /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
