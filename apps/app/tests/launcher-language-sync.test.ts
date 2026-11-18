import { expect, test } from "bun:test";
import { currentLanguagePreference, currentLocale, initLocale, setLanguagePreference, subscribeLocale, t } from "../src/i18n";

test("translation requests fill every occurrence of the selected language in English and German", () => {
  expect(t("launcher.flow.translate_prompt", "en", { language: "English", fallback: "German" })).toBe(
    "Translate the selected passage into English. If it is already in English, translate it into German. Return only the translation.",
  );
  expect(t("launcher.flow.translate_prompt", { lng: "de", language: "German", fallback: "English" })).toBe(
    "Übersetzen Sie den ausgewählten Abschnitt in German. Falls er bereits in German ist, übersetzen Sie ihn in English. Geben Sie nur die Übersetzung zurück.",
  );
});

test("translation parameters keep dollar signs literal", () => {
  expect(t("launcher.flow.translate_prompt", "en", { language: "$&", fallback: "$'" })).toBe(
    "Translate the selected passage into $&. If it is already in $&, translate it into $'. Return only the translation.",
  );
});

test("refreshing language from another window or the system repaints subscribers without rewriting settings", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousPreference = currentLanguagePreference();
  let stored = "en", languages = ["en-US"], notifications = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => stored } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ languages }) });
  const unsubscribe = subscribeLocale(() => { notifications++; });
  try {
    initLocale();
    notifications = 0;
    stored = "de";
    initLocale();
    expect(currentLocale()).toBe("de");
    expect(notifications).toBeGreaterThan(0);
    stored = "system";
    languages = ["de-AT"];
    initLocale();
    expect(currentLocale()).toBe("de");
    languages = ["en-GB"];
    initLocale();
    expect(currentLocale()).toBe("en");
  } finally {
    unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    setLanguagePreference(previousPreference);
  }
});
