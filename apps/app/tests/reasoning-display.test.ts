import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SHOW_THINKING,
  SHOW_THINKING_DEFAULT_VERSION,
  applyShowThinkingDefault,
  type LocalPreferences,
} from "../src/react-app/kernel/local-provider";

// The legacy SessionTranscript markup test was removed with the legacy
// message list (#2016). Reasoning markup for the current transcript is
// covered by the app e2e checks which drive the real app.

function prefs(overrides: Partial<LocalPreferences>): LocalPreferences {
  return {
    showThinking: DEFAULT_SHOW_THINKING,
    showThinkingChosen: false,
    showThinkingDefaultVersion: 0,
    hideAppMode: "recording",
    modelVariant: null,
    defaultModel: null,
    selectedAgent: null,
    releaseChannel: "stable",
    featureFlags: { microsandboxCreateSandbox: true },
    hasCompletedOnboarding: false,
    onboardingStage: "done",
    analyticsEnabled: null,
    fusionModels: [],
    ...overrides,
  };
}

describe("reasoning display", () => {
  test("defaults reasoning visibility off", () => {
    expect(DEFAULT_SHOW_THINKING).toBe(false);
  });

  test("a store that only carried the old 'on' default is turned off", () => {
    // What every pre-existing install has persisted: the old default, never chosen.
    const migrated = applyShowThinkingDefault(prefs({ showThinking: true }));
    expect(migrated.showThinking).toBe(false);
    expect(migrated.showThinkingChosen).toBe(false);
    expect(migrated.showThinkingDefaultVersion).toBe(SHOW_THINKING_DEFAULT_VERSION);
  });

  test("a value the user chose survives a default change", () => {
    const migrated = applyShowThinkingDefault(prefs({ showThinking: true, showThinkingChosen: true }));
    expect(migrated.showThinking).toBe(true);
    expect(migrated.showThinkingDefaultVersion).toBe(SHOW_THINKING_DEFAULT_VERSION);
  });

  test("a store already on the current default generation is left alone", () => {
    const current = prefs({
      showThinking: true,
      showThinkingChosen: false,
      showThinkingDefaultVersion: SHOW_THINKING_DEFAULT_VERSION,
    });
    expect(applyShowThinkingDefault(current)).toBe(current);
  });
});
