/**
 * Four lawyer-facing transcription tiers layered over the raw model catalog.
 * Users never see "whisper-small" / "parakeet-tdt-0.6b-v3"; they see Basic /
 * Standard / Premium / Maximum with a plain-English benefit.
 */
import { t } from "@/i18n";

export type ModelTierKey = "basic" | "standard" | "premium" | "max";

export type ModelTier = {
  key: ModelTierKey;
  /** The catalog model id this tier installs. */
  modelId: string;
  premium: boolean;
  /** Heaviest tier: only offered without a warning on a capable machine. */
  requiresFastDevice?: boolean;
};

/** Order = how they render (good → better → best). */
export const MODEL_TIERS: ModelTier[] = [
  { key: "basic", modelId: "whisper-tiny", premium: false },
  { key: "standard", modelId: "whisper-small", premium: false },
  { key: "premium", modelId: "parakeet-tdt-0.6b-v3", premium: true },
  { key: "max", modelId: "whisper-large-v3", premium: true, requiresFastDevice: true },
];

export function tierForModelId(modelId: string): ModelTier | null {
  return MODEL_TIERS.find((tier) => tier.modelId === modelId) ?? null;
}

// Static keys (no template literals): the i18n audit rejects runtime-built
// t() keys, and static cases stay greppable for the missing-key check.
export function tierName(key: ModelTierKey): string {
  switch (key) {
    case "basic":
      return t("recorder.tier_basic_name");
    case "standard":
      return t("recorder.tier_standard_name");
    case "premium":
      return t("recorder.tier_premium_name");
    case "max":
      return t("recorder.tier_max_name");
  }
}

export function tierTagline(key: ModelTierKey): string {
  switch (key) {
    case "basic":
      return t("recorder.tier_basic_tagline");
    case "standard":
      return t("recorder.tier_standard_tagline");
    case "premium":
      return t("recorder.tier_premium_tagline");
    case "max":
      return t("recorder.tier_max_tagline");
  }
}

/**
 * Real premium entitlement, driven by the connected Eigenwelt firm's active
 * subscription (the platform emits the `premium_models` feature only when the
 * org isEntitled — plan plus/pro with an active/trialing/past_due status).
 *
 * Kept a plain synchronous function (no args) so both React components AND the
 * non-React recorder store can call the same gate. The value is a module-level
 * cache written by <EigenweltPremiumSync/>, which reads the entitlements query
 * and calls `setEigenweltPremiumEntitled` whenever the plan changes — so a sub
 * going active or lapsing flips every premium gate live.
 *
 * A model can still be unlocked one at a time for testing without a sub: see
 * the recorder store's `unlockedModels` / `unlockModelForTesting`.
 */
let premiumEntitledState = false;
let premiumEntitlementKnown = false;
let premiumPlatformUrl: string | null = null;

export function isPremiumEntitled(): boolean {
  return premiumEntitledState;
}

/**
 * Whether the sub state has actually been resolved yet. Guards the recorder's
 * fallback so a cold start (entitlements not fetched) doesn't wrongly demote a
 * subscriber's premium model before we know their plan.
 */
export function isPremiumEntitlementKnown(): boolean {
  return premiumEntitlementKnown;
}

/** Called by the entitlement sync once the firm's plan/status is known. */
export function setEigenweltPremiumEntitled(entitled: boolean, platformUrl?: string | null): void {
  premiumEntitledState = entitled;
  premiumEntitlementKnown = true;
  if (platformUrl !== undefined) premiumPlatformUrl = platformUrl;
}

/** Platform origin for the upsell modal's billing/upgrade CTA (null → default). */
export function eigenweltPremiumPlatformUrl(): string | null {
  return premiumPlatformUrl;
}
