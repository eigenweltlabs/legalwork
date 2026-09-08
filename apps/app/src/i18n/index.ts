import en from "./locales/en";
import de from "./locales/de";
export const LANGUAGE_PREF_KEY = "legalwork.language";

/**
 * Supported languages.
 *
 * Only fully translated languages ship. `locales/` still holds partial
 * ja/zh/vi/pt-BR/th/fr/ca/es/ru files from an earlier pass (all under 50%
 * translated); they are deliberately not registered here, so they appear
 * neither in the Settings picker nor in auto-detection. To bring one back,
 * finish its translation and add it to `Language`, `LANGUAGES`,
 * `LANGUAGE_OPTIONS`, `TRANSLATIONS` and `pluralRulesByLanguage` below, plus
 * `COMPLETE` in `scripts/i18n-check.ts`.
 */
export type Language = "en" | "de";
export type Locale = Language;

/**
 * What the user picked in Settings. `"system"` means "follow the OS/browser
 * language", which is also the default for a fresh install.
 */
export type LanguagePreference = Language | "system";

export const SYSTEM_LANGUAGE: LanguagePreference = "system";

/**
 * All supported languages - single source of truth. Drives the Settings
 * picker AND auto-detection, so the two can never disagree.
 */
export const LANGUAGES: Language[] = ["en", "de"];

/**
 * Language options for UI - single source of truth
 */
export const LANGUAGE_OPTIONS = [
  { value: "en" as Language, label: "English", nativeName: "English" },
  { value: "de" as Language, label: "German", nativeName: "Deutsch" },
] as const;

/**
 * Translation maps
 */
const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en,
  de,
};

/**
 * Type guard to validate if a value is a Language
 * Replaces long chains like: value === "en" || value === "zh"
 */
export const isLanguage = (value: unknown): value is Language => {
  return typeof value === "string" && LANGUAGES.includes(value as Language);
};

export const isLanguagePreference = (value: unknown): value is LanguagePreference => {
  return value === SYSTEM_LANGUAGE || isLanguage(value);
};

/* ------------------------------------------------------------------ */
/*  System language detection                                          */
/* ------------------------------------------------------------------ */

/**
 * Map a single BCP-47 tag onto a supported language, or null when we ship no
 * translation for it. Matching is case-insensitive and tries the full tag
 * first, then the primary subtag ("de-AT" -> "de").
 *
 * A regional locale (say "pt-BR") would also need an alias table here so a
 * bare "pt" resolves to it; with only "en" and "de" shipping, the primary
 * subtag is enough.
 */
export const matchLanguageTag = (tag: string): Language | null => {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return null;

  const exact = LANGUAGES.find((language) => language.toLowerCase() === normalized);
  if (exact) return exact;

  const primary = normalized.split("-")[0];
  return LANGUAGES.find((language) => language.toLowerCase().split("-")[0] === primary) ?? null;
};

/**
 * The language the OS/browser asks for, or "en" when none of the preferred
 * languages is one we ship. `navigator.languages` is ordered by preference, so
 * the first supported entry wins.
 */
export const detectSystemLanguage = (): Language => {
  if (typeof navigator === "undefined") return "en";

  const tags = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];

  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const matched = matchLanguageTag(tag);
    if (matched) return matched;
  }

  return "en";
};

/* ------------------------------------------------------------------ */
/*  Current locale + subscriptions                                     */
/* ------------------------------------------------------------------ */

let localeValue: Language = "en";
let preferenceValue: LanguagePreference = SYSTEM_LANGUAGE;

const listeners = new Set<() => void>();

/**
 * Subscribe to locale changes. Returns an unsubscribe function, so this plugs
 * straight into `useSyncExternalStore`.
 */
export const subscribeLocale = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * Get current locale
 */
export const currentLocale = (): Language => locale();
function locale(): Language {
  return localeValue;
}

/**
 * The stored Settings choice: an explicit language, or "system" when the app
 * follows the OS/browser.
 */
export const currentLanguagePreference = (): LanguagePreference => preferenceValue;

const applyLocale = (next: Language) => {
  const changed = localeValue !== next;
  localeValue = next;

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", next);
  }

  if (changed) notify();
};

/**
 * Set locale and persist to localStorage
 */
export const setLocale = (newLocale: Language) => {
  if (!isLanguage(newLocale)) {
    console.warn(`Invalid locale: ${newLocale}, falling back to "en"`);
    newLocale = "en";
  }

  setLanguagePreference(newLocale);
};

/**
 * Persist the Settings choice. `"system"` drops the stored override so the app
 * follows the OS/browser language from now on.
 */
export const setLanguagePreference = (preference: LanguagePreference) => {
  if (!isLanguagePreference(preference)) {
    console.warn(`Invalid language preference: ${preference}, falling back to "system"`);
    preference = SYSTEM_LANGUAGE;
  }

  const previousPreference = preferenceValue;
  preferenceValue = preference;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LANGUAGE_PREF_KEY, preference);
    } catch (e) {
      console.warn("Failed to persist language preference:", e);
    }
  }

  applyLocale(preference === SYSTEM_LANGUAGE ? detectSystemLanguage() : preference);
  // The resolved locale can be unchanged (picking "German" while the system is
  // already German), but the Settings row still has to redraw.
  if (previousPreference !== preference) notify();
};

/**
 * Resolve a translation entry with the locale → English → null fallback chain.
 */
const lookupEntry = (loc: Language, candidateKey: string): string | null => {
  if (TRANSLATIONS[loc]?.[candidateKey]) return TRANSLATIONS[loc][candidateKey];
  if (loc !== "en" && TRANSLATIONS.en?.[candidateKey]) return TRANSLATIONS.en[candidateKey];
  return null;
};

const pluralRulesByLanguage: Record<Language, Intl.PluralRules> = {
  en: new Intl.PluralRules("en"),
  de: new Intl.PluralRules("de"),
};
const pluralRule = (loc: Language, count: number): Intl.LDMLPluralRule => {
  return pluralRulesByLanguage[loc].select(count);
};

/**
 * Pick the right key variant for a count. Tries `${key}_zero` (only when count === 0),
 * then `${key}_${rule}` (e.g. `_one` / `_other`), then `${key}_other`, then the bare
 * key. Each candidate runs through the locale → English fallback so an
 * untranslated key still resolves to the English `_one` / `_other` variant.
 */
const resolvePluralKey = (loc: Language, key: string, count: number): string => {
  const candidates: string[] = [];
  if (count === 0) candidates.push(`${key}_zero`);
  candidates.push(`${key}_${pluralRule(loc, count)}`, `${key}_other`, key);

  for (const candidate of candidates) {
    if (lookupEntry(loc, candidate) !== null) return candidate;
  }
  return key;
};

/**
 * Translation function with fallback behavior.
 * - Locale fallback: target language → English → key itself.
 * - Plural fallback: when params include a numeric `count`, the lookup picks
 *   `${key}_one` / `${key}_other` (or `${key}_zero` when count === 0) per
 *   `Intl.PluralRules`, and falls back to the bare key when no variants exist.
 */
type TranslationParams = Record<string, string | number> & { lng?: Language };

export const t = (
  key: string,
  paramsOrLocale?: TranslationParams | Language,
  legacyParams?: Record<string, string | number>,
): string => {
  const params = legacyParams ?? (typeof paramsOrLocale === "string" ? undefined : paramsOrLocale);
  const loc: Language = typeof paramsOrLocale === "string"
    ? paramsOrLocale
    : isLanguage(params?.lng)
      ? params.lng
      : locale();

  const lookupKey =
    typeof params?.count === "number" ? resolvePluralKey(loc, key, params.count) : key;

  const result = lookupEntry(loc, lookupKey);
  if (result === null) return key;

  if (!params) return result;

  let out = result;
  for (const [k, v] of Object.entries(params)) {
    if (k === "lng") continue;
    out = out.replace(`{${k}}`, String(v));
  }
  return out;
};

/**
 * Initialize locale from localStorage, falling back to the OS/browser language
 * when the user has never picked one (or picked "System"). A stored language
 * we no longer ship fails the guard and falls back to detection.
 * Call this during app initialization.
 */
export const initLocale = (): Language => {
  if (typeof window === "undefined") {
    return "en";
  }

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LANGUAGE_PREF_KEY);
  } catch (e) {
    console.warn("Failed to read language preference:", e);
  }

  preferenceValue = isLanguagePreference(stored) ? stored : SYSTEM_LANGUAGE;
  const resolved = preferenceValue === SYSTEM_LANGUAGE ? detectSystemLanguage() : preferenceValue;

  localeValue = resolved;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", resolved);
  }

  return resolved;
};
