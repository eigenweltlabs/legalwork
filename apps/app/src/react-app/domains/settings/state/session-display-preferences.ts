import { useCallback } from "react";

import { DEFAULT_SHOW_THINKING, useLocal } from "../../../kernel/local-provider";

type BooleanUpdater = boolean | ((current: boolean) => boolean);

export function useSessionDisplayPreferences() {
  const { prefs, setPrefs } = useLocal();

  const setShowThinking = useCallback(
    (value: BooleanUpdater) => {
      setPrefs((previous) => ({
        ...previous,
        showThinking:
          typeof value === "function" ? value(previous.showThinking) : value,
        showThinkingChosen: true,
      }));
    },
    [setPrefs],
  );

  const toggleShowThinking = useCallback(() => {
    setShowThinking((current) => !current);
  }, [setShowThinking]);

  const resetSessionDisplayPreferences = useCallback(() => {
    // Back to "never chose": future default changes apply again.
    setPrefs((previous) => ({
      ...previous,
      showThinking: DEFAULT_SHOW_THINKING,
      showThinkingChosen: false,
    }));
  }, [setPrefs]);

  return {
    showThinking: prefs.showThinking,
    setShowThinking,
    toggleShowThinking,
    resetSessionDisplayPreferences,
  };
}
