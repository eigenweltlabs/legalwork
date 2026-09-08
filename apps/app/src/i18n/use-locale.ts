import { useSyncExternalStore } from "react";

import { currentLanguagePreference, currentLocale, subscribeLocale } from ".";
import type { Language, LanguagePreference } from ".";

/**
 * Re-render on language changes. `t()` is a plain function that reads a module
 * variable, so a component only picks up a new language if something in its
 * tree subscribes. Mount this near the root (and in any island that renders
 * outside it) to make a language switch repaint the whole app immediately.
 */
export const useLocale = (): Language =>
  useSyncExternalStore(subscribeLocale, currentLocale, () => "en" as Language);

/**
 * The stored Settings choice ("system" or an explicit language), re-rendering
 * whenever it changes.
 */
export const useLanguagePreference = (): LanguagePreference =>
  useSyncExternalStore(
    subscribeLocale,
    currentLanguagePreference,
    () => "system" as LanguagePreference,
  );
