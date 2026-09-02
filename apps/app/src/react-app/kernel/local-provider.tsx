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
import { setAnalyticsDistinctId } from "../../app/lib/analytics";
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

/**
 * Screen-capture privacy for the LegalWork window (setContentProtection):
 * `never` = always capturable; `recording` = hidden only while the Recorder is
 * capturing; `always` = always hidden from screen shares / recordings.
 */
export type HideAppMode = "never" | "recording" | "always";

export type LocalPreferences = {
  /** Show the model's reasoning in the chat. Off unless the user turns it on. */
  showThinking: boolean;
  /**
   * True once the user flipped the reasoning toggle themselves. The stored
   * value alone cannot tell a choice from a persisted default, so this is what
   * lets a later change of the default reach everyone who never chose.
   */
  showThinkingChosen: boolean;
  /**
   * The DEFAULT_SHOW_THINKING generation this store was last aligned with
   * (see applyShowThinkingDefault). Stores from before the field existed read
   * as 0 and get the current default applied once.
   */
  showThinkingDefaultVersion: number;
  /** When to exclude the window from screen shares / recordings. */
  hideAppMode: HideAppMode;
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
   * Where the in-session onboarding covers stand. PERSISTED so a reload or
   * crash resumes the flow instead of silently ending it. One action per
   * step: "ai" (start the trial / skip) -> "office" (install the Word
   * add-in) -> "audio" (turn on transcription & dictation) -> "done".
   * "setup" is a legacy value from an interim build, treated as "office".
   * The welcome route sets "ai" when the first workspace is created.
   */
  onboardingStage: "ai" | "office" | "audio" | "setup" | "done";
  /**
   * User preference committed from the welcome-screen toggle (nothing is
   * applied before then); switchable anytime in Settings -> Privacy.
   * `null` means the user has not made a choice yet — do not persist a
   * concrete default, or the welcome toggle's opt-out default is defeated.
   */
  analyticsEnabled: boolean | null;
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
export const DEFAULT_SHOW_THINKING = false;
/**
 * Bump whenever DEFAULT_SHOW_THINKING changes. Version 1 was the original
 * "on" default; 2 turned it off. Every store below the current version gets
 * the new default unless the user chose a value themselves.
 */
export const SHOW_THINKING_DEFAULT_VERSION = 2;

const INITIAL_UI: LocalUIState = { view: "settings", tab: "general" };
const INITIAL_PREFS: LocalPreferences = {
  showThinking: DEFAULT_SHOW_THINKING,
  showThinkingChosen: false,
  // 0, not the current version: readPersisted fills missing fields from here,
  // so an older store must still look "behind" for applyShowThinkingDefault.
  showThinkingDefaultVersion: 0,
  hideAppMode: "recording",
  modelVariant: null,
  defaultModel: null,
  selectedAgent: null,
  releaseChannel: "stable",
  featureFlags: { microsandboxCreateSandbox: true },
  hasCompletedOnboarding: false,
  onboardingStage: "done",
  // null until the user chooses on the welcome screen — persisting a concrete
  // value here would make getStoredAnalyticsConsent() report a choice that was
  // never made, defeating the welcome toggle's default.
  analyticsEnabled: null,
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

/**
 * Align a loaded store with the current reasoning default: a store from an
 * older default generation keeps the user's own choice, but a value that was
 * only ever the old persisted default is replaced by the current default.
 */
export function applyShowThinkingDefault(prefs: LocalPreferences): LocalPreferences {
  if (prefs.showThinkingDefaultVersion >= SHOW_THINKING_DEFAULT_VERSION) return prefs;
  return {
    ...prefs,
    showThinking: prefs.showThinkingChosen ? prefs.showThinking : DEFAULT_SHOW_THINKING,
    showThinkingDefaultVersion: SHOW_THINKING_DEFAULT_VERSION,
  };
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
    const persisted = applyShowThinkingDefault(readPersisted(PREFS_STORAGE_KEY, INITIAL_PREFS));
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

  // Sync analytics consent with the local server and adopt its per-launch
  // distinct id in return. In-memory on both sides; retried briefly because
  // the server may still be booting. Desktop only. Until the round-trip
  // succeeds, analytics falls back to a locally minted id.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 8 && !cancelled; attempt += 1) {
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = await resolveLegalworkConnection();
          if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
            const result = await createLegalworkServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken || undefined,
              hostToken: resolvedHostToken || undefined,
            }).setAnalyticsIdentity({ analyticsEnabled: prefs.analyticsEnabled === true });
            if (typeof result?.distinctId === "string") setAnalyticsDistinctId(result.distinctId);
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
        // The legacy key was only ever written by the toggle: a real choice.
        setPrefsRaw((previous) => ({ ...previous, showThinking: parsed, showThinkingChosen: true }));
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
