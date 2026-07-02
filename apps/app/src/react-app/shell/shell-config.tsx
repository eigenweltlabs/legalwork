/** @jsxImportSource react */
import { createContext, useCallback, use, useMemo, useState, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ShellConfig = {
  /** Display name shown in the title bar, sidebar, and welcome page. */
  appName: string;
  /** Brand name shown at the top of the left sidebar. */
  sidebarBrandName: string;
  /** Optional user-uploaded brand logo (data URL) for the left sidebar. */
  sidebarBrandLogoDataUrl: string;
  /** Show the bottom status bar (connection status, docs, feedback). */
  statusBar: boolean;
  /** Show the left sidebar with workspace/session list. */
  sidebar: boolean;
  /** Show the Cloud sign-in button when not signed in. */
  cloudSignin: boolean;
  /** Show the welcome/onboarding page for new users. */
  welcomePage: boolean;
  /** Show starter task cards in empty sessions. */
  starterCards: boolean;
  /** Show the model picker / model change UI. */
  modelPicker: boolean;
  /** Show the built-in browser panel. */
  browser: boolean;
  /** Show the "Add workspace" button. */
  addWorkspace: boolean;
  /** Show the notification bell in the header. */
  notifications: boolean;
  /** Show the right-hand panel rail (browser, voice, artifacts, extensions). */
  panelRail: boolean;
};

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  appName: "LegalWork",
  sidebarBrandName: "LegalWork",
  sidebarBrandLogoDataUrl: "",
  statusBar: true,
  sidebar: true,
  cloudSignin: true,
  welcomePage: true,
  starterCards: true,
  modelPicker: true,
  browser: true,
  addWorkspace: true,
  notifications: false,
  panelRail: true,
};

/* ------------------------------------------------------------------ */
/*  Persistence                                                        */
/* ------------------------------------------------------------------ */

export const SHELL_CONFIG_STORAGE_KEY = "legalwork.shell-config";
const STORAGE_KEY = SHELL_CONFIG_STORAGE_KEY;

function readShellConfig(): ShellConfig {
  if (typeof window === "undefined") return DEFAULT_SHELL_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SHELL_CONFIG;
    const parsed = JSON.parse(raw);
    const next = { ...DEFAULT_SHELL_CONFIG, ...parsed };
    return {
      ...next,
      // The notifications bell has no UI toggle anymore, so force it off even if
      // an older persisted config had it enabled.
      notifications: false,
      sidebarBrandName: String(next.sidebarBrandName ?? DEFAULT_SHELL_CONFIG.sidebarBrandName).trim() || DEFAULT_SHELL_CONFIG.sidebarBrandName,
      sidebarBrandLogoDataUrl: String(next.sidebarBrandLogoDataUrl ?? "").trim(),
    };
  } catch {
    return DEFAULT_SHELL_CONFIG;
  }
}

function writeShellConfig(config: ShellConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage errors.
  }
}

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

type ShellConfigContextValue = {
  config: ShellConfig;
  update: (patch: Partial<ShellConfig>) => void;
  reset: () => void;
};

const ShellConfigContext = createContext<ShellConfigContextValue | undefined>(undefined);

export function ShellConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ShellConfig>(readShellConfig);

  const update = useCallback((patch: Partial<ShellConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      writeShellConfig(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setConfig(DEFAULT_SHELL_CONFIG);
    writeShellConfig(DEFAULT_SHELL_CONFIG);
  }, []);

  const value = useMemo<ShellConfigContextValue>(
    () => ({ config, update, reset }),
    [config, update, reset],
  );

  return (
    <ShellConfigContext.Provider value={value}>
      {children}
    </ShellConfigContext.Provider>
  );
}

export function useShellConfig(): ShellConfigContextValue {
  const ctx = use(ShellConfigContext);
  if (!ctx) {
    throw new Error("useShellConfig must be used within a ShellConfigProvider");
  }
  return ctx;
}
