/**
 * Three lawyer-facing transcription tiers layered over the raw model catalog.
 * Users never see "whisper-small" / "parakeet-tdt-0.6b-v3"; they see Basic /
 * Standard / Premium with a plain-English benefit.
 */
import { t } from "@/i18n";

export type ModelTierKey = "basic" | "standard" | "premium";

export type ModelTier = {
  key: ModelTierKey;
  /** The catalog model id this tier installs. */
  modelId: string;
  premium: boolean;
};

/** Order = how they render (good → better → best). */
export const MODEL_TIERS: ModelTier[] = [
  { key: "basic", modelId: "whisper-tiny", premium: false },
  { key: "standard", modelId: "whisper-small", premium: false },
  { key: "premium", modelId: "parakeet-tdt-0.6b-v3", premium: true },
];

export function tierForModelId(modelId: string): ModelTier | null {
  return MODEL_TIERS.find((tier) => tier.modelId === modelId) ?? null;
}

export function tierName(key: ModelTierKey): string {
  return t(`recorder.tier_${key}_name`);
}

export function tierTagline(key: ModelTierKey): string {
  return t(`recorder.tier_${key}_tagline`);
}

/**
 * PLACEHOLDER premium entitlement. Parakeet and any future premium model stay
 * locked until this returns true. Auth is being built separately — when it
 * lands, wire this to the real entitlement (e.g. read from the auth/session
 * store). Kept a plain function so both React and the recorder store can call
 * it. Until then it is always false so the locked/upgrade UI is exercised.
 *
 * TODO(auth): return the real premium entitlement here.
 */
export function isPremiumEntitled(): boolean {
  return false;
}
