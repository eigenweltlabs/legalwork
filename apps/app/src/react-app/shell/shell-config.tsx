/** @jsxImportSource react */
import { createContext, useCallback, use, useMemo, useState, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ShellNavKey = "navHome" | "navScheduled" | "navCalendar" | "navProjects" | "navTasks" | "navWorkflows" | "navRecorder" | "navEvaluations";

const DEFAULT_NAV_ORDER: ShellNavKey[] = ["navHome", "navProjects", "navCalendar", "navTasks", "navScheduled", "navWorkflows", "navRecorder", "navEvaluations"];

export type ChatSectionKey = "navNewChat" | "sectionPinned" | "sectionPinnedProjects" | "sectionProjects" | "sectionRecent";
export type ProjectNavKey = "projectCalendar" | "projectHome" | "projectReviews" | "projectTasks" | "projectFiles" | "projectSessions";
const DEFAULT_CHAT_ORDER: ChatSectionKey[] = ["navNewChat", "sectionPinned", "sectionPinnedProjects", "sectionProjects", "sectionRecent"];
const DEFAULT_PROJECT_ORDER: ProjectNavKey[] = ["projectHome", "projectCalendar", "projectReviews", "projectTasks", "projectFiles", "projectSessions"];

export type ShellConfig = {
  navHome: boolean;
  navCalendar: boolean;
  navScheduled: boolean;
  navProjects: boolean;
  chatSectionOrder: ChatSectionKey[];
  sectionPinned: boolean;
  sectionPinnedProjects: boolean;
  sectionProjects: boolean;
  sectionRecent: boolean;
  projectNavOrder: ProjectNavKey[];
  projectCalendar: boolean;
  projectHome: boolean;
  projectReviews: boolean;
  projectTasks: boolean;
  projectFiles: boolean;
  /** Retained for saved config compatibility; sessions are always enabled. */
  projectSessions: true;
  collapseProjectSessions: boolean;
  navOrder: ShellNavKey[];
  navNewChat: boolean;
  navTasks: boolean;
  navWorkflows: boolean;
  navRecorder: boolean;
  navEvaluations: boolean;
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
  navOrder: DEFAULT_NAV_ORDER,
  navHome: true,
  navCalendar: true,
  navScheduled: true,
  navProjects: true,
  chatSectionOrder: DEFAULT_CHAT_ORDER,
  sectionPinned: true,
  sectionPinnedProjects: true,
  sectionProjects: true,
  sectionRecent: true,
  projectNavOrder: DEFAULT_PROJECT_ORDER,
  projectCalendar: true,
  projectHome: true,
  projectReviews: true,
  projectTasks: true,
  projectFiles: true,
  projectSessions: true,
  collapseProjectSessions: true,
  navNewChat: true,
  navTasks: true,
  navWorkflows: true,
  navRecorder: true,
  navEvaluations: true,
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

function readOrder<K extends string>(value: unknown, defaults: K[]): K[] {
  const saved = Array.isArray(value)
    ? value.filter((key): key is K => defaults.some((item) => item === key))
    : [];
  return [...new Set([...saved, ...defaults])];
}

function readShellConfig(): ShellConfig {
  if (typeof window === "undefined") return DEFAULT_SHELL_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SHELL_CONFIG;
    const parsed = JSON.parse(raw);
    const next = { ...DEFAULT_SHELL_CONFIG, ...parsed };
    const savedNavOrder = Array.isArray(next.navOrder) ? next.navOrder.flatMap((key: unknown) => key === "navNewChat" ? ["navHome", "navProjects"] : [key]) : next.navOrder;
    const navOrder = readOrder(savedNavOrder, DEFAULT_NAV_ORDER);
    // Place newly available items beside their default neighbors, preserving saved ordering.
    if (Array.isArray(savedNavOrder) && !savedNavOrder.includes("navCalendar")) {
      navOrder.splice(navOrder.indexOf("navCalendar"), 1);
      navOrder.splice(navOrder.indexOf("navProjects") + 1, 0, "navCalendar");
    }
    if (Array.isArray(savedNavOrder) && !savedNavOrder.includes("navScheduled")) {
      navOrder.splice(navOrder.indexOf("navScheduled"), 1);
      navOrder.splice(navOrder.indexOf("navTasks") + 1, 0, "navScheduled");
    }
    const chatSectionOrder = readOrder(next.chatSectionOrder, DEFAULT_CHAT_ORDER);
    if (Array.isArray(next.chatSectionOrder) && !next.chatSectionOrder.includes("sectionPinnedProjects")) {
      chatSectionOrder.splice(chatSectionOrder.indexOf("sectionPinnedProjects"), 1);
      chatSectionOrder.splice(chatSectionOrder.indexOf("sectionPinned") + 1, 0, "sectionPinnedProjects");
    }
    return {
      ...next,
      navOrder,
      chatSectionOrder,
      projectNavOrder: readOrder(next.projectNavOrder, DEFAULT_PROJECT_ORDER),
      projectSessions: true,
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
      const next: ShellConfig = { ...prev, ...patch, projectSessions: true };
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
