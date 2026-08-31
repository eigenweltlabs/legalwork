/** @jsxImportSource react */
/**
 * Onboarding: the "Your AI" step. One primary path — sign in with Eigenwelt,
 * which runs the platform funnel (create your firm, start the 7-day trial,
 * checkout) in the browser and connects the app the moment it finishes. The
 * only other exit is a deliberately small "use your own model" link that opens
 * the provider modal (bring-your-own key/endpoint). There is no free tier.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { openDesktopUrl } from "@/app/lib/desktop";
import { t } from "@/i18n";
import { ProviderIcon } from "../../design-system/provider-icon";
import { OnboardingCover } from "./onboarding-cover";

export type AiStepProps = {
  /** Bind the OAuth loopback and return the browser URL (provider-auth store). */
  onStartSignIn: () => Promise<{ authorizeUrl: string; sessionId: string }>;
  /** Long-poll until the browser flow completes. */
  onWaitSignIn: (
    sessionId: string,
    opts?: { cancelled?: () => boolean },
  ) => Promise<{ connected: boolean; cancelled?: boolean; message?: string }>;
  /** Sign-in finished and the connection is live — advance the flow. */
  onConnected: () => void;
  /** The small skip: open the searchable provider modal (BYO key/endpoint). */
  onUseOwnModel: () => void;
  /** True while the LegalWork server connection is still coming up. */
  serverReady: boolean;
};

export function AiStep(props: AiStepProps) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping cancels an in-flight wait (unmount or explicit cancel).
  const waitTokenRef = useRef(0);
  useEffect(() => () => void ++waitTokenRef.current, []);

  useEffect(() => {
    captureAnalyticsEvent("onboarding_ai_viewed");
  }, []);

  const signIn = async () => {
    setConnecting(true);
    setError(null);
    captureAnalyticsEvent("onboarding_ai_eigenwelt_started");
    const token = ++waitTokenRef.current;
    try {
      const { authorizeUrl, sessionId } = await props.onStartSignIn();
      await openDesktopUrl(authorizeUrl);
      const result = await props.onWaitSignIn(sessionId, {
        cancelled: () => waitTokenRef.current !== token,
      });
      if (result.connected) {
        captureAnalyticsEvent("onboarding_ai_completed", { method: "eigenwelt" });
        props.onConnected();
        return;
      }
      if (!result.cancelled && result.message) setError(result.message);
    } catch (signInError) {
      if (waitTokenRef.current === token) {
        setError(signInError instanceof Error ? signInError.message : String(signInError));
        captureAnalyticsEvent("onboarding_ai_eigenwelt_failed");
      }
    } finally {
      if (waitTokenRef.current === token) setConnecting(false);
    }
  };

  const cancelSignIn = () => {
    ++waitTokenRef.current;
    setConnecting(false);
  };

  const panelItems = [
    { title: t("onboarding_ai.panel_item1_title"), desc: t("onboarding_ai.panel_item1_body") },
    { title: t("onboarding_ai.panel_item2_title"), desc: t("onboarding_ai.panel_item2_body") },
    { title: t("onboarding_ai.panel_item3_title"), desc: t("onboarding_ai.panel_item3_body") },
    { title: t("onboarding_ai.panel_item4_title"), desc: t("onboarding_ai.panel_item4_body") },
  ];

  return (
    <OnboardingCover
      panel={
        <>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              {t("onboarding_ai.panel_eyebrow")}
            </span>
            <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
              {t("onboarding_ai.panel_title")}
            </h2>
          </div>
          <div className="divide-y divide-white/10 border-y border-white/10">
            {panelItems.map((item) => (
              <div key={item.title} className="flex items-baseline gap-4 py-3.5">
                <span className="mt-1 size-1.5 shrink-0 translate-y-1.5 rounded-full bg-[#0a58c2]" />
                <div className="min-w-0">
                  <div className="text-[14px] font-medium tracking-[-0.01em] text-white">{item.title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-snug text-white/55">{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            {t("onboarding_ai.panel_footer")}
          </p>
        </>
      }
    >
      <div className="flex w-full max-w-md flex-col gap-8">
        <div>
          <span className="lw-section-eyebrow uppercase text-dls-secondary">
            {t("onboarding_ai.eyebrow")}
          </span>
          <h1 className="mt-3 text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
            {t("onboarding_ai.title")}
          </h1>
          <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
            {t("onboarding_ai.subtitle")}
          </p>
        </div>

        {connecting ? (
          <div className="flex flex-col gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-4">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 shrink-0 animate-spin text-dls-secondary" />
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-dls-text">
                  {t("onboarding_ai.waiting_title")}
                </div>
                <div className="text-[12px] text-dls-secondary">{t("onboarding_ai.waiting_body")}</div>
              </div>
            </div>
            <button
              type="button"
              className="self-start text-[12px] text-dls-secondary underline underline-offset-2 transition-colors hover:text-dls-text"
              onClick={cancelSignIn}
            >
              {t("onboarding_ai.cancel")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Button
              size="lg"
              className="w-full justify-center"
              disabled={!props.serverReady}
              onClick={() => void signIn()}
            >
              <ProviderIcon providerId="eigenwelt" size={16} />
              {t("onboarding_ai.cta")}
            </Button>
            <p className="text-center text-[12px] leading-5 text-dls-secondary">
              {t("onboarding_ai.cta_note")}
            </p>
          </div>
        )}

        {error ? <p className="text-[12.5px] leading-relaxed text-red-11">{error}</p> : null}
        {!props.serverReady ? (
          <p className="-mt-4 text-[12px] text-dls-secondary">{t("account.server_required")}</p>
        ) : null}

        {/* The only path around Eigenwelt: deliberately small. */}
        <div className="border-t border-dls-border pt-5">
          <button
            type="button"
            className="group inline-flex items-center gap-1 text-[13px] text-dls-secondary transition-colors hover:text-dls-text"
            onClick={() => {
              captureAnalyticsEvent("onboarding_ai_byo_clicked");
              props.onUseOwnModel();
            }}
          >
            {t("onboarding_ai.byo")}
            <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>
      </div>
    </OnboardingCover>
  );
}
