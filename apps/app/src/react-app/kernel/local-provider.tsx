/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { THINKING_PREF_KEY } from "../../app/constants";
import { getAnalyticsDistinctId } from "../../app/lib/analytics";
import { createLegalworkServerClient } from "../../app/lib/legalwork-server";
import { coerceReleaseChannel } from "../../app/lib/release-channels";
import { isDesktopRuntime } from "../../app/lib/runtime-env";
import { resolveLegalworkConnection } from "../shell/legalwork-connection";
import type { ModelRef, ReleaseChannel, SettingsTab, View } from "../../app/types";
import { readStoredDefaultModel } from "./model-config";

export type LocalUIState = {
  view: View;
  tab: SettingsTab;
};

export type LocalPreferences = {
  showThinking: boolean;
  modelVariant: string | null;
  defaultModel: ModelRef | null;
  /**
   * Name of the opencode agent used for new prompts (null = the server's
   * default, usually "build"). Persisted so a reload does not silently
   * fall back to the default agent (#2101).
   */
  selectedAgent: string | null;
  /**
   * Release channel the desktop app is subscribed to. Defaults to
   * "stable". Alpha is only honored on macOS; the updater helper falls
   * back to stable elsewhere.
   */
  releaseChannel: ReleaseChannel;
  featureFlags: {
    microsandboxCreateSandbox: boolean;
  };
  /**
   * Set to true after the user completes the welcome/onboarding flow
   * (creates or connects their first workspace). When false and the
   * workspace list is empty, the app redirects to /welcome.
   */
  hasCompletedOnboarding: boolean;
  /**
   * Anonymous product analytics (PostHog). Committed from the welcome-screen
   * toggle (nothing is sent before then); switchable anytime in
   * Settings -> Privacy. See analytics.ts for the data model.
   */
  analyticsEnabled: boolean;
  /**
   * Fusion mode defaults: up to three candidate models preselected in the
   * chat's fusion picker when fusion is turned on. The session's default
   * model acts as the main/fusion model.
   */
  fusionModels: ModelRef[];
};

type LocalContextValue = {
  ui: LocalUIState;
  setUi: (updater: (previous: LocalUIState) => LocalUIState) => void;
  prefs: LocalPreferences;
  setPrefs: (updater: (previous: LocalPreferences) => LocalPreferences) => void;
  ready: boolean;
};

const LocalContext = createContext<LocalContextValue | undefined>(undefined);

const UI_STORAGE_KEY = "legalwork.ui";
const PREFS_STORAGE_KEY = "legalwork.preferences";
export const DEFAULT_SHOW_THINKING = true;

const INITIAL_UI: LocalUIState = { view: "settings", tab: "general" };
const INITIAL_PREFS: LocalPreferences = {
  showThinking: DEFAULT_SHOW_THINKING,
  modelVariant: null,
  defaultModel: null,
  selectedAgent: null,
  releaseChannel: "stable",
  featureFlags: { microsandboxCreateSandbox: true },
  hasCompletedOnboarding: false,
  analyticsEnabled: false,
  fusionModels: [],
};

function readPersisted<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return { ...fallback, ...(parsed as Record<string, unknown>) } as T;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writePersisted(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

type LocalProviderProps = {
  children: ReactNode;
};

export function LocalProvider({ children }: LocalProviderProps) {
  const [ui, setUiRaw] = useState<LocalUIState>(() =>
    readPersisted(UI_STORAGE_KEY, INITIAL_UI),
  );
  const [prefs, setPrefsRaw] = useState<LocalPreferences>(() => {
    const persisted = readPersisted(PREFS_STORAGE_KEY, INITIAL_PREFS);
    if (persisted.defaultModel) {
      return persisted;
    }
    return {
      ...persisted,
      defaultModel: readStoredDefaultModel(),
    };
  });
  const ready = true;
  const migratedThinkingRef = useRef(false);

  useEffect(() => {
    writePersisted(UI_STORAGE_KEY, ui);
  }, [ui]);

  useEffect(() => {
    writePersisted(PREFS_STORAGE_KEY, prefs);
  }, [prefs]);

  // Push the analytics identity (per-launch id + consent) to the local server
  // for the Office pane. In-memory on the server; retried briefly because the
  // server may still be booting. Desktop only.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    const payload = {
      // The id is only handed out while analytics is on.
      distinctId: prefs.analyticsEnabled ? getAnalyticsDistinctId() : null,
      analyticsEnabled: prefs.analyticsEnabled,
    };
    void (async () => {
      for (let attempt = 0; attempt < 8 && !cancelled; attempt += 1) {
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = await resolveLegalworkConnection();
          if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
            await createLegalworkServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken || undefined,
              hostToken: resolvedHostToken || undefined,
            }).setAnalyticsIdentity(payload);
            return;
          }
        } catch {
          // Server not reachable yet — retry below.
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefs.analyticsEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (migratedThinkingRef.current) return;
    migratedThinkingRef.current = true;

    const raw = window.localStorage.getItem(THINKING_PREF_KEY);
    if (raw == null) return;

    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "boolean") {
        setPrefsRaw((previous) => ({ ...previous, showThinking: parsed }));
      }
    } catch {
      // ignore invalid legacy values
    }

    try {
      window.localStorage.removeItem(THINKING_PREF_KEY);
    } catch {
      // ignore
    }
  }, []);

  const setUi = useCallback(
    (updater: (previous: LocalUIState) => LocalUIState) => {
      setUiRaw(updater);
    },
    [],
  );

  const setPrefs = useCallback(
    (updater: (previous: LocalPreferences) => LocalPreferences) => {
      setPrefsRaw(updater);
    },
    [],
  );

  const value = useMemo<LocalContextValue>(
    () => ({ ui, setUi, prefs, setPrefs, ready }),
    [prefs, ready, setPrefs, setUi, ui],
  );

  return <LocalContext.Provider value={value}>{children}</LocalContext.Provider>;
}

export function useLocal(): LocalContextValue {
  const context = use(LocalContext);
  if (!context) {
    throw new Error("Local context is missing");
  }
  return context;
}
