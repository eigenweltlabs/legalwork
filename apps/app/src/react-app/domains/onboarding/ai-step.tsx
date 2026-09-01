/** @jsxImportSource react */
/**
 * Onboarding: the "Your AI" step. One action — sign in with Eigenwelt, which
 * runs the platform funnel (create your firm, start the 7-day trial,
 * checkout) in the browser and connects the app the moment it finishes.
 * The only other exit is a plain Skip. There is no free tier.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { openDesktopUrl } from "@/app/lib/desktop";
import { t } from "@/i18n";
import { ProviderIcon } from "../../design-system/provider-icon";
import { CoverSkipButton, OnboardingCover, StepDots } from "./onboarding-cover";

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
  /** The one way around the trial: a plain skip. */
  onSkip: () => void;
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

  // The panel shows the product doing legal work, not another bullet list.
  const chatMock = (
    <div className="mx-auto w-full max-w-[380px] rounded-xl border border-white/10 bg-[#0b1322]/90 p-4 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.8)] backdrop-blur">
      <div className="ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm bg-white/10 px-3 py-2 text-[12.5px] leading-snug text-white/85">
        {t("onboarding_ai.chat_user")}
      </div>
      <div className="mt-3 max-w-[92%] rounded-lg rounded-tl-sm bg-[#0a58c2]/25 px-3 py-2.5">
        <p className="text-[12.5px] leading-snug text-white/85">{t("onboarding_ai.chat_answer")}</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60">
            {t("onboarding_ai.chat_chip1")}
          </span>
          <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60">
            {t("onboarding_ai.chat_chip2")}
          </span>
        </div>
      </div>
    </div>
  );

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
          {chatMock}
          <div className="grid grid-cols-2 gap-2.5">
            {panelItems.map((item) => (
              <div key={item.title} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <div className="text-[12.5px] font-medium tracking-[-0.01em] text-white">{item.title}</div>
                <div className="mt-1 text-[11px] leading-snug text-white/50">{item.desc}</div>
              </div>
            ))}
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            {t("onboarding_ai.panel_footer")}
          </p>
        </>
      }
      footerRight={
        <CoverSkipButton
          label={t("onboarding.skip")}
          onClick={() => {
            captureAnalyticsEvent("onboarding_ai_skipped");
            props.onSkip();
          }}
        />
      }
    >
      <div className="flex w-full max-w-md flex-col gap-8">
        <div>
          <StepDots step={2} total={4} />
          <h1 className="text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
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
            <p className="text-center text-[13px] text-dls-secondary">
              {t("onboarding_ai.login_prompt")}{" "}
              <button
                type="button"
                className="font-medium text-dls-text underline underline-offset-2 transition-opacity hover:opacity-80"
                onClick={() => {
                  captureAnalyticsEvent("onboarding_ai_login_clicked");
                  void signIn();
                }}
              >
                {t("onboarding_ai.login_cta")}
              </button>
            </p>
          </div>
        )}

        {error ? <p className="text-[12.5px] leading-relaxed text-red-11">{error}</p> : null}
        {!props.serverReady ? (
          <p className="-mt-4 text-[12px] text-dls-secondary">{t("account.server_required")}</p>
        ) : null}

      </div>
    </OnboardingCover>
  );
}
