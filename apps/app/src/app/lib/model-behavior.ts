import type { ProviderListItem } from "../types";
import type { ModelBehaviorOption } from "../types";
import { t } from "../../i18n";

type ProviderModel = ProviderListItem["models"][string];

const WELL_KNOWN_VARIANT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const normalizeModelBehaviorValue = (value: string | null) => {
  // Preferences store literal catalog keys; null alone means provider default.
  return value?.trim() || null;
};

const getVariantKeys = (model: ProviderModel) =>
  Object.entries(model.variants ?? {}).filter(([, options]) => options.disabled !== true).map(([key]) => key);

const sortVariantKeys = (keys: string[]) =>
  keys.slice().sort((a, b) => {
    const aIndex = WELL_KNOWN_VARIANT_ORDER.indexOf(a as (typeof WELL_KNOWN_VARIANT_ORDER)[number]);
    const bIndex = WELL_KNOWN_VARIANT_ORDER.indexOf(b as (typeof WELL_KNOWN_VARIANT_ORDER)[number]);
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
    return a.localeCompare(b);
  });

const providerFamily = (providerID: string, providerName?: string | null) => {
  const normalizedId = providerID.trim().toLowerCase();
  if (["anthropic", "openai", "google", "opencode"].includes(normalizedId)) {
    return normalizedId;
  }

  const normalizedName = providerName?.trim().toLowerCase() ?? "";
  if (normalizedName.includes("anthropic")) return "anthropic";
  if (normalizedName.includes("openai")) return "openai";
  if (normalizedName.includes("google")) return "google";
  if (normalizedName.includes("opencode")) return "opencode";
  return normalizedId;
};

const getBehaviorTitle = (
  providerID: string,
  model: ProviderModel,
  variantKeys: string[],
  providerName?: string | null,
) => {
  const family = providerFamily(providerID, providerName);
  if (variantKeys.length > 0) {
    if (family === "anthropic") return t("model_behavior.title_extended_thinking");
    if (family === "google") return t("model_behavior.title_reasoning_budget");
    if (
      family === "openai" ||
      family === "opencode" ||
      variantKeys.some((key) => ["none", "minimal", "low", "medium", "high", "xhigh"].includes(key))
    ) {
      return t("model_behavior.title_reasoning_effort");
    }
    return t("app.model_behavior_title");
  }
  if (model.capabilities?.reasoning) return t("model_behavior.title_builtin_reasoning");
  return t("model_behavior.title_standard_generation");
};

// Variant names are the catalog's literal names, including custom providers.
const getVariantLabel = (_providerID: string, key: string, _providerName?: string | null) => key;

export const formatGenericBehaviorLabel = (value: string | null) => {
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return t("app.model_behavior_title");
  return getVariantLabel("generic", normalized);
};

const getVariantDescription = (
  providerID: string,
  key: string,
  label: string,
  providerName?: string | null,
) => {
  const family = providerFamily(providerID, providerName);
  if (key === "none") return t("model_behavior.desc_none");
  if (key === "minimal") return t("model_behavior.desc_minimal");
  if (key === "low") return family === "google"
    ? t("model_behavior.desc_low_google")
    : t("model_behavior.desc_low");
  if (key === "medium") return t("model_behavior.desc_medium");
  if (key === "high") return family === "anthropic"
    ? t("model_behavior.desc_high_anthropic")
    : t("model_behavior.desc_high");
  if (key === "xhigh" || key === "max") return family === "anthropic"
    ? t("model_behavior.desc_max_anthropic")
    : t("model_behavior.desc_max");
  return t("model_behavior.desc_generic", { label: label.toLowerCase() });
};

export const getModelBehaviorOptions = (
  providerID: string,
  model: ProviderModel,
  providerName?: string | null,
): ModelBehaviorOption[] => {
  const variantKeys = sortVariantKeys(getVariantKeys(model));
  if (!variantKeys.length) return [];
  const defaultKey = defaultVariantKey(model);
  return variantKeys.map((key) => {
    const label = getVariantLabel(providerID, key, providerName);
    return {
      value: key,
      label,
      isDefault: key === defaultKey,
      description: getVariantDescription(providerID, key, label, providerName),
    };
  });
};

const defaultVariantKey = (model: ProviderModel) => getVariantKeys(model).find((key) => {
  const entries = Object.entries(model.variants?.[key] ?? {}).filter(([name]) => name !== "disabled");
  // A matching effort alone is insufficient if the variant adds other settings.
  return entries.length > 0 && entries.every(([name, value]) =>
    JSON.stringify(model.options?.[name]) === JSON.stringify(value));
});

export const sanitizeModelBehaviorValue = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
  providerName?: string | null,
) => {
  if (!value) return null;
  const keys = getVariantKeys(model);
  const literal = value.trim();
  if (keys.includes(literal)) return literal;
  const normalized = normalizeModelBehaviorValue(value);
  if (!normalized) return null;
  return keys.find((key) => key.toLowerCase() === normalized.toLowerCase()) ?? null;
};

export const getModelBehaviorSummary = (
  providerID: string,
  model: ProviderModel,
  value: string | null,
  providerName?: string | null,
) => {
  const options = getModelBehaviorOptions(providerID, model, providerName);
  const sanitized = sanitizeModelBehaviorValue(providerID, model, value, providerName);
  // Display the configured native default while leaving the variant override unset.
  const selected = options.find((option) => option.value === (sanitized ?? defaultVariantKey(model)));
  const title = getBehaviorTitle(providerID, model, getVariantKeys(model), providerName);

  if (options.length > 0) {
    return {
      title,
      label: selected?.label ?? title,
      description: selected?.description ?? t("model_behavior.desc_builtin"),
      value: sanitized,
      options,
    };
  }

  if (model.capabilities?.reasoning) {
    return {
      title,
      label: t("model_behavior.label_builtin"),
      description: t("model_behavior.desc_builtin"),
      value: null,
      options,
    };
  }

  return {
    title,
    label: t("model_behavior.label_standard"),
    description: t("model_behavior.desc_standard"),
    value: null,
    options,
  };
};
