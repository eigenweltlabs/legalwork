/** @jsxImportSource react */
/**
 * The premium upsell "challenge" modal. Three phases, driven by
 * PremiumUpsellProvider:
 *   pitch   → the €25 Plus benefits + "Upgrade to Plus" CTA (reuses the app's
 *             feature-announcement shell so it matches the what's-new modals).
 *   waiting → checkout is open in the browser; a spinner + "Continue in your
 *             browser" while the provider polls for the subscription.
 *   success → a checkmark confirmation before the provider auto-closes.
 *   timeout → the poll gave up; it still unlocks on its own once active.
 *
 * The three benefits are exactly what the $/€25 Plus plan unlocks: premium audio
 * transcription models, included EU/ZDR AI usage, and firm-wide sharing of
 * workflows & integrations.
 */
import { useState } from "react";
import { Check, CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { PaperGrainGradient } from "@legalwork/ui/react";

import { openDesktopUrl } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { FeatureAnnouncementModal } from "@/react-app/design-system/modals/feature-announcement-modal";
import { eigenweltBillingUrl } from "@/react-app/domains/connections/eigenwelt-entitlements";

import { eigenweltPremiumPlatformUrl } from "./model-tiers";

export type PremiumUpsellPhase = "pitch" | "waiting" | "success" | "timeout";

/** The onboarding "lab" showcase gradient — deep navy → electric blue, grained. */
function PremiumHero() {
  return (
    <PaperGrainGradient
      className="size-full"
      speed={0}
      scale={1.1}
      rotation={0}
      offsetX={0}
      offsetY={0}
      softness={0.75}
      intensity={0.55}
      noise={0.16}
      shape="corners"
      frame={37706.748}
      colors={["#0a1633", "#0a67c6", "#0a58c2", "#05080f"]}
      colorBack="#05080f"
    />
  );
}

export function PremiumUpsellModal(props: {
  open: boolean;
  phase: PremiumUpsellPhase;
  /** False when the client/workspace isn't ready — hides the polling promise. */
  canPoll: boolean;
  /** Whether the desktop is signed in with an Eigenwelt firm. */
  connected: boolean;
  /** Whether a sign-in handler is available. */
  canSignIn: boolean;
  /** Sign-in is in progress. */
  signingIn: boolean;
  onSignIn: () => void;
  onUpgrade: () => void;
  onClose: () => void;
}) {
  const platformURL = eigenweltPremiumPlatformUrl();
  const checkoutUrl = eigenweltBillingUrl(platformURL);
  const [copied, setCopied] = useState(false);

  const copyCheckoutUrl = async () => {
    try {
      await navigator.clipboard.writeText(checkoutUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failures
    }
  };

  // Pitch: the standard feature-announcement layout. When the desktop isn't
  // signed in with Eigenwelt, the CTA is "Sign in with Eigenwelt" first — you
  // can only subscribe a firm you belong to. Once connected it becomes "Upgrade
  // to Plus" (checkout + success poll).
  if (props.phase === "pitch") {
    const needsSignIn = props.canSignIn && !props.connected;
    const primaryAction = needsSignIn
      ? {
          label: props.signingIn ? t("premium_upsell.signing_in") : t("premium_upsell.sign_in"),
          onClick: () => {
            if (!props.signingIn) props.onSignIn();
          },
        }
      : {
          label: t("premium_upsell.cta"),
          onClick: () => {
            // Open Stripe checkout in the browser, then hand off to the provider's
            // poll loop (unless we can't poll, in which case just close).
            void openDesktopUrl(checkoutUrl);
            if (props.canPoll) props.onUpgrade();
            else props.onClose();
          },
        };
    return (
      <FeatureAnnouncementModal
        open={props.open}
        eyebrow={t("premium_upsell.eyebrow")}
        headline={t("premium_upsell.headline")}
        intro={needsSignIn ? t("premium_upsell.intro_signin") : t("premium_upsell.intro")}
        heroOverlay={<PremiumHero />}
        entries={[
          { title: t("premium_upsell.audio_title"), body: t("premium_upsell.audio_body") },
          { title: t("premium_upsell.eu_title"), body: t("premium_upsell.eu_body") },
          { title: t("premium_upsell.share_title"), body: t("premium_upsell.share_body") },
        ]}
        primaryAction={primaryAction}
        dismissLabel={t("premium_upsell.dismiss")}
        onDismiss={props.onClose}
      />
    );
  }

  // Waiting / success / timeout: a compact status card. Closing it (Esc /
  // backdrop / the button) aborts the provider's poll loop.
  const success = props.phase === "success";
  const timeout = props.phase === "timeout";
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          {success ? (
            <CheckCircle2 className="size-10 text-success" />
          ) : timeout ? (
            <Loader2 className="size-10 text-subtext" />
          ) : (
            <Loader2 className="size-10 animate-spin text-brand" />
          )}
          <div>
            <DialogTitle className="text-lg font-medium tracking-[-0.02em] text-ink">
              {success
                ? t("premium_upsell.success_title")
                : timeout
                  ? t("premium_upsell.timeout_title")
                  : t("premium_upsell.waiting_title")}
            </DialogTitle>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-subtext">
              {success
                ? t("premium_upsell.success_body")
                : timeout
                  ? t("premium_upsell.timeout_body")
                  : t("premium_upsell.waiting_body")}
            </p>
          </div>

          {/* Checkout link + copy, in case the browser tab was closed. */}
          {success ? null : (
            <div className="w-full space-y-2 text-left">
              <div className="text-[10px] uppercase tracking-wide text-tertiary">
                {t("premium_upsell.checkout_link")}
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-subtle bg-sunken px-3 py-2">
                <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtext">{checkoutUrl}</div>
                <Button variant="ghost" size="icon-sm" aria-label={t("premium_upsell.copy_link")} onClick={() => void copyCheckoutUrl()}>
                  {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => void openDesktopUrl(checkoutUrl)}>
                  <ExternalLink data-icon="inline-start" />
                  {t("premium_upsell.open_again")}
                </Button>
                <Button variant="ghost" size="sm" className="flex-1" onClick={props.onClose}>
                  {timeout ? t("premium_upsell.timeout_dismiss") : t("premium_upsell.waiting_cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
