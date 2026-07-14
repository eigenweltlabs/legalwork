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
 * Session-only override that dismisses the premium lock for testing. Until auth
 * lands, {@link isPremiumEntitled} is always false, so the premium models can't
 * be exercised at all. Clicking "continue" in the gate dialog flips this so the
 * paid models stay testable. In-memory only, resets on reload.
 *
 * TODO(auth): delete this together with the placeholder in isPremiumEntitled.
 */
let premiumTestOverride = false;

export function setPremiumTestOverride(on: boolean): void {
  premiumTestOverride = on;
}

/**
 * PLACEHOLDER premium entitlement. Parakeet and any future premium model stay
 * locked until this returns true. Auth is being built separately — when it
 * lands, wire this to the real entitlement (e.g. read from the auth/session
 * store). Kept a plain function so both React and the recorder store can call
 * it. Until then it is driven only by the testing override above.
 *
 * TODO(auth): return the real premium entitlement here (dropping the override).
 */
export function isPremiumEntitled(): boolean {
  return premiumTestOverride;
}
