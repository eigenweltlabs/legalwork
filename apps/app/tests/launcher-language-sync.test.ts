import { expect, test } from "bun:test";
import { currentLanguagePreference, currentLocale, initLocale, setLanguagePreference, subscribeLocale } from "../src/i18n";

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
