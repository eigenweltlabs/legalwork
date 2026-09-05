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
import { useLocation, useNavigate } from "react-router-dom";

export type LegalworkControlSideEffect = "none" | "navigation" | "mutation" | "external";

export type LegalworkControlActionArg = {
  name: string;
  type?: "string" | "number" | "boolean" | "object" | "array" | "unknown";
  required?: boolean;
  description?: string;
};

export type LegalworkControlActionMetadata = {
  id: string;
  label: string;
  description?: string;
  sideEffect: LegalworkControlSideEffect;
  requiresConfirmation: boolean;
  requiresArgs: boolean;
  hasPreviewArgs: boolean;
  previewArgs?: unknown;
  args?: LegalworkControlActionArg[];
  disabled: boolean;
  busy: boolean;
};

export type LegalworkControlSnapshot = {
  version: number;
  enabled: boolean;
  route: string;
  status: "off" | "ready" | "acting";
  busyActionId: string | null;
  narration: string;
  activeSurface: LegalworkControlSurface | null;
  actions: LegalworkControlActionMetadata[];
};

export type LegalworkControlSurface = {
  id: string;
  kind: "document";
  format: "docx";
  sessionId: string;
  workspaceId: string;
  name: string;
  path: string;
  editable: boolean;
  agentEditsTracked: boolean;
};

export type LegalworkControlResult =
  | { ok: true; actionId: string; result?: unknown }
  | { ok: false; actionId: string; error: string };

export type LegalworkControlHelpers = {
  setNarration: (text: string) => void;
};

export type LegalworkControlTargetRef = {
  readonly current: HTMLElement | null;
};

export type LegalworkControlAction = {
  id: string;
  label: string;
  description?: string;
  sideEffect?: LegalworkControlSideEffect;
  requiresConfirmation?: boolean;
  requiresArgs?: boolean;
  args?: LegalworkControlActionArg[];
  previewArgs?: unknown;
  disabled?: boolean;
  targetRef?: LegalworkControlTargetRef;
  execute: (args: unknown, helpers: LegalworkControlHelpers) => unknown | Promise<unknown>;
};

type ControlActionRef = {
  readonly current: LegalworkControlAction | null;
};

type RegisteredAction = {
  id: string;
  order: number;
  token: symbol;
  ref: ControlActionRef;
};

type SpotlightState = {
  visible: boolean;
  phase: "target" | "press";
  rect: { x: number; y: number; width: number; height: number } | null;
};

type LegalworkControlContextValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  route: string;
  narration: string;
  busyActionId: string | null;
  actions: LegalworkControlActionMetadata[];
  registerAction: (actionId: string, actionRef: ControlActionRef) => () => void;
  registerSurface: (surface: LegalworkControlSurface) => () => void;
  executeAction: (actionId: string, args?: unknown) => Promise<LegalworkControlResult>;
  snapshot: () => LegalworkControlSnapshot;
};

type LegalworkControlAPI = {
  version: number;
  snapshot: () => LegalworkControlSnapshot;
  listActions: () => LegalworkControlActionMetadata[];
  execute: (actionId: string, args?: unknown) => Promise<LegalworkControlResult>;
  setEnabled: (enabled: boolean) => void;
  subscribe: (listener: (snapshot: LegalworkControlSnapshot) => void) => () => void;
};

declare global {
  interface Window {
    __legalworkControl?: LegalworkControlAPI;
  }
}

const CONTROL_API_VERSION = 1;
const LegalworkControlContext = createContext<LegalworkControlContextValue | null>(null);
const SPOTLIGHT_TIMING_MS = Object.freeze({
  missingTarget: 80,
  scrollIntoView: 180,
  target: 260,
  press: 130,
  release: 80,
  done: 280,
});

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function returnedActionError(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const payload = result as { ok?: unknown; error?: unknown };
  if (payload.ok !== false) return null;
  return typeof payload.error === "string" && payload.error.trim()
    ? payload.error
    : "Action returned an error.";
}

function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function metadataForAction(registered: RegisteredAction, busyActionId: string | null): LegalworkControlActionMetadata {
  const action = registered.ref.current;
  return {
    id: registered.id,
    label: action?.label ?? registered.id,
    description: action?.description,
    sideEffect: action?.sideEffect ?? "none",
    requiresConfirmation: action?.requiresConfirmation === true,
    requiresArgs: action?.requiresArgs === true,
    hasPreviewArgs: action?.previewArgs !== undefined,
    previewArgs: action?.previewArgs,
    args: action?.args,
    disabled: action?.disabled === true,
    busy: busyActionId === registered.id,
  };
}

function ControlModeSpotlight({ spotlight }: { spotlight: SpotlightState }) {
  const rect = spotlight.rect;
  if (!spotlight.visible || !rect) return null;

  const pad = spotlight.phase === "press" ? 8 : 12;
  return (
    <div
      className="pointer-events-none fixed z-[9998] rounded-[18px] bg-[rgba(var(--dls-accent-rgb),0.1)] shadow-[0_0_0_9999px_rgba(7,10,18,0.08),0_0_36px_rgba(var(--dls-accent-rgb),0.32),inset_0_0_0_1px_rgba(var(--dls-accent-rgb),0.24)] transition-all duration-200 ease-out"
      style={{
        left: `${rect.x - pad}px`,
        top: `${rect.y - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
        transform: spotlight.phase === "press" ? "scale(0.985)" : "scale(1)",
      }}
    />
  );
}

export function LegalworkControlProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const actionsRef = useRef(new Map<string, RegisteredAction>());
  const listenersRef = useRef(new Set<(snapshot: LegalworkControlSnapshot) => void>());
  const nextOrderRef = useRef(1);
  const [version, setVersion] = useState(0);
  const [enabledState, setEnabledState] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [narration, setNarration] = useState("Control mode is off.");
  const [activeSurface, setActiveSurface] = useState<LegalworkControlSurface | null>(null);
  const [spotlight, setSpotlight] = useState<SpotlightState>({ visible: false, phase: "target", rect: null });
  const busyActionIdRef = useRef<string | null>(null);
  const activeSurfaceTokenRef = useRef<symbol | null>(null);
  const spotlightRunRef = useRef(0);

  const route = `${location.pathname}${location.search}${location.hash}`;
  const enabled = enabledState;
  const status: LegalworkControlSnapshot["status"] = !enabled ? "off" : busyActionId ? "acting" : "ready";

  const setEnabled = useCallback((nextEnabled: boolean) => {
    setEnabledState(nextEnabled);
  }, []);

  const listActionMetadata = useCallback((nextBusyActionId = busyActionId) => {
    return Array.from(actionsRef.current.values())
      .sort((left, right) => left.order - right.order)
      .map((action) => metadataForAction(action, nextBusyActionId));
  }, [busyActionId, version]);

  const actions = useMemo(() => {
    return listActionMetadata();
  }, [listActionMetadata]);

  const snapshot = useCallback((): LegalworkControlSnapshot => ({
    version: CONTROL_API_VERSION,
    enabled,
    route,
    status,
    busyActionId,
    narration,
    activeSurface,
    actions: listActionMetadata(),
  }), [activeSurface, busyActionId, enabled, listActionMetadata, narration, route, status]);

  const registerAction = useCallback((actionId: string, actionRef: ControlActionRef) => {
    const token = Symbol(actionId);
    const previous = actionsRef.current.get(actionId);
    actionsRef.current.set(actionId, {
      id: actionId,
      order: previous?.order ?? nextOrderRef.current++,
      token,
      ref: actionRef,
    });
    setVersion((current) => current + 1);

    return () => {
      const current = actionsRef.current.get(actionId);
      if (current?.token === token) {
        actionsRef.current.delete(actionId);
        setVersion((value) => value + 1);
      }
    };
  }, []);

  const registerSurface = useCallback((surface: LegalworkControlSurface) => {
    const token = Symbol(surface.id);
    activeSurfaceTokenRef.current = token;
    setActiveSurface(surface);

    return () => {
      if (activeSurfaceTokenRef.current !== token) return;
      activeSurfaceTokenRef.current = null;
      setActiveSurface(null);
    };
  }, []);

  const playTargetChoreography = useCallback(async (action: LegalworkControlAction, runId: number) => {
    if (!isBrowser()) return;
    const stillCurrent = () => spotlightRunRef.current === runId;
    const target = action.targetRef?.current;
    if (!target) {
      await wait(SPOTLIGHT_TIMING_MS.missingTarget);
      return;
    }

    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    await wait(SPOTLIGHT_TIMING_MS.scrollIntoView);
    if (!stillCurrent() || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    setSpotlight({
      visible: true,
      phase: "target",
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
    });
    await wait(SPOTLIGHT_TIMING_MS.target);
    if (!stillCurrent()) return;
    setSpotlight((current) => ({ ...current, phase: "press" }));
    await wait(SPOTLIGHT_TIMING_MS.press);
    if (!stillCurrent()) return;
    setSpotlight((current) => ({ ...current, phase: "target" }));
    await wait(SPOTLIGHT_TIMING_MS.release);
  }, []);

  const executeAction = useCallback(async (actionId: string, args?: unknown): Promise<LegalworkControlResult> => {
    const registered = actionsRef.current.get(actionId);
    const action = registered?.ref.current;
    if (!registered || !action) return { ok: false, actionId, error: `Unknown action: ${actionId}` };
    if (action.disabled) return { ok: false, actionId, error: `Action is disabled: ${action.label}` };
    if (busyActionIdRef.current) return { ok: false, actionId, error: `Already acting: ${busyActionIdRef.current}` };

    if (action.requiresConfirmation && isBrowser()) {
      const confirmed = window.confirm(`Allow Control Mode to ${action.label}?`);
      if (!confirmed) return { ok: false, actionId, error: "User cancelled action." };
    }

    const runId = spotlightRunRef.current + 1;
    spotlightRunRef.current = runId;
    busyActionIdRef.current = action.id;
    setEnabled(true);
    setBusyActionId(action.id);
    setNarration(`Moving to ${action.label}…`);

    try {
      await playTargetChoreography(action, runId);
      setNarration(`Running ${action.label}…`);
      const effectiveArgs = args === undefined ? action.previewArgs : args;
      const result = await action.execute(effectiveArgs, { setNarration });
      const resultError = returnedActionError(result);
      if (resultError) {
        setNarration(`Could not ${action.label}: ${resultError}`);
        if (spotlightRunRef.current === runId) {
          setSpotlight({ visible: false, phase: "target", rect: null });
        }
        return { ok: false, actionId, error: resultError };
      }
      setNarration(`Done: ${action.label}`);
      await wait(SPOTLIGHT_TIMING_MS.done);
      if (spotlightRunRef.current === runId) {
        setSpotlight({ visible: false, phase: "target", rect: null });
      }
      return { ok: true, actionId, result };
    } catch (error) {
      const message = describeError(error);
      setNarration(`Could not ${action.label}: ${message}`);
      if (spotlightRunRef.current === runId) {
        setSpotlight({ visible: false, phase: "target", rect: null });
      }
      return { ok: false, actionId, error: message };
    } finally {
      if (busyActionIdRef.current === action.id) busyActionIdRef.current = null;
      setBusyActionId(null);
    }
  }, [playTargetChoreography, setEnabled]);

  const value = useMemo<LegalworkControlContextValue>(() => ({
    enabled,
    setEnabled,
    route,
    narration,
    busyActionId,
    actions,
    registerAction,
    registerSurface,
    executeAction,
    snapshot,
  }), [actions, busyActionId, enabled, executeAction, narration, registerAction, registerSurface, route, setEnabled, snapshot]);

  useEffect(() => {
    if (!enabled) {
      setNarration("Control mode is off.");
    } else if (narration === "Control mode is off.") {
      setNarration("Ready. A controller can inspect and run visible actions.");
    }
  }, [enabled, narration]);

  useEffect(() => {
    if (!isBrowser()) return;

    const api: LegalworkControlAPI = {
      version: CONTROL_API_VERSION,
      snapshot,
      listActions: () => snapshot().actions,
      execute: executeAction,
      setEnabled,
      subscribe(listener) {
        listenersRef.current.add(listener);
        listener(snapshot());
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    };

    window.__legalworkControl = api;
    return () => {
      if (window.__legalworkControl === api) {
        delete window.__legalworkControl;
      }
    };
  }, [executeAction, setEnabled, snapshot]);

  useEffect(() => {
    busyActionIdRef.current = busyActionId;
  }, [busyActionId]);

  useEffect(() => {
    const next = snapshot();
    listenersRef.current.forEach((listener) => listener(next));
  }, [snapshot, version]);

  return (
    <LegalworkControlContext.Provider value={value}>
      {children}
      <ControlModeSpotlight spotlight={spotlight} />
    </LegalworkControlContext.Provider>
  );
}

export function useLegalworkControl() {
  return use(LegalworkControlContext);
}

export function useControlAction(action: LegalworkControlAction | null | false | undefined) {
  const control = useLegalworkControl();
  const registerAction = control?.registerAction;
  const latestActionRef = useRef<LegalworkControlAction | null>(action || null);
  latestActionRef.current = action || null;
  const actionId = action ? action.id : null;

  useEffect(() => {
    if (!registerAction || !actionId) return undefined;
    return registerAction(actionId, latestActionRef);
  }, [actionId, registerAction]);
}

export function useControlSurface(surface: LegalworkControlSurface | null | false | undefined) {
  const control = useLegalworkControl();
  const registerSurface = control?.registerSurface;

  useEffect(() => {
    if (!registerSurface || !surface) return undefined;
    return registerSurface(surface);
  }, [registerSurface, surface]);
}

/**
 * Register a dynamic list of control actions. Unlike calling useControlAction
 * per item, this scales to an arbitrary, changing number of actions without
 * violating the rules of hooks. Each action is tracked by its stable id; the
 * latest closure for that id is always used, and removed ids are unregistered.
 */
export function useControlActions(actions: readonly LegalworkControlAction[]) {
  const control = useLegalworkControl();
  const registerAction = control?.registerAction;

  // One ref per action id, so executeAction always sees the freshest closure.
  const refsById = useRef<Map<string, { current: LegalworkControlAction | null }>>(new Map());
  for (const action of actions) {
    const existing = refsById.current.get(action.id);
    if (existing) {
      existing.current = action;
    } else {
      refsById.current.set(action.id, { current: action });
    }
  }

  const ids = actions.map((action) => action.id).join("\u0000");

  useEffect(() => {
    if (!registerAction) return undefined;
    const liveIds = new Set(actions.map((action) => action.id));
    // Drop refs for ids that no longer exist.
    for (const id of Array.from(refsById.current.keys())) {
      if (!liveIds.has(id)) refsById.current.delete(id);
    }
    const cleanups = actions.map((action) => {
      const ref = refsById.current.get(action.id);
      return ref ? registerAction(action.id, ref) : undefined;
    });
    return () => {
      for (const cleanup of cleanups) cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerAction, ids]);
}

import { SETTINGS_TAB_VALUES } from "../../../app/types";

const SETTINGS_TABS: ReadonlySet<string> = new Set<string>(SETTINGS_TAB_VALUES);

export function LegalworkRouteControlActions() {
  const navigate = useNavigate();

  const actions = useMemo<LegalworkControlAction[]>(() => [
    {
      id: "route.session",
      label: "Open sessions",
      description: "Navigate to the main session view.",
      sideEffect: "navigation",
      execute: () => navigate("/session"),
    },
    {
      id: "route.settings.general",
      label: "Open general settings",
      description: "Navigate to general settings.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/general"),
    },
    {
      id: "route.settings.extensions",
      label: "Open MCP and extension settings",
      description: "Navigate to extension and MCP settings.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/extensions"),
    },
    {
      id: "route.settings.skills",
      label: "Open skills settings",
      description: "Navigate to skills settings.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/skills"),
    },
    {
      id: "route.settings.providers",
      label: "Open provider settings",
      description: "Navigate to AI provider settings.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/ai"),
    },
    {
      id: "route.settings.authorized_folders",
      label: "Open authorized folder settings",
      description: "Navigate to authorized folders and file access settings.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/permissions"),
    },
    {
      id: "route.settings.appearance",
      label: "Open appearance settings",
      description: "Navigate to appearance settings.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/appearance"),
    },
    {
      id: "settings.panel.open",
      label: "Open a settings panel",
      description: "Navigate to a specific settings panel by tab id.",
      sideEffect: "navigation",
      requiresArgs: true,
      args: [
        {
          name: "panel",
          type: "string",
          required: true,
          description:
            "Settings tab: general | ai | preferences | permissions | shell | extensions | skills | environment | advanced | appearance | updates | recovery | debug | cloud-account | cloud-workers | cloud-providers | cloud-marketplaces",
        },
      ],
      previewArgs: { panel: "ai" },
      execute: (args) => {
        const requested = (args as { panel?: unknown } | undefined)?.panel;
        const panel = typeof requested === "string" ? requested.trim() : "";
        if (!SETTINGS_TABS.has(panel)) {
          return {
            ok: false,
            error: `Unknown settings panel: ${panel || "(empty)"}. Expected one of ${Array.from(SETTINGS_TABS).join(", ")}.`,
          };
        }
        navigate(`/settings/${panel}`);
        return { ok: true, panel };
      },
    },
    {
      id: "route.back",
      label: "Go back",
      description: "Navigate back one entry in history.",
      sideEffect: "navigation",
      execute: () => navigate(-1),
    },
    {
      id: "route.forward",
      label: "Go forward",
      description: "Navigate forward one entry in history.",
      sideEffect: "navigation",
      execute: () => navigate(1),
    },
    {
      id: "help.capabilities",
      label: "What can LegalWork do?",
      description: "List the main capabilities of LegalWork.",
      sideEffect: "none",
      execute: () => ({
        capabilities: [
          { id: "browse", label: "Browse the web", description: "Control a browser to navigate, scrape, and automate web tasks." },
          { id: "providers", label: "AI model providers", description: "Connect Anthropic, OpenAI, Google, OpenRouter, Ollama, or other LLM providers." },
          { id: "extensions", label: "MCP extensions", description: "Add MCP servers for Google Workspace, GitHub, databases, and more." },
          { id: "voice", label: "Voice mode", description: "Talk to LegalWork with real-time voice using OpenAI Realtime." },
          { id: "files", label: "File management", description: "Read, write, and organize files in your workspace." },
          { id: "code", label: "Write and run code", description: "Generate, edit, and execute code with full tool access." },
          { id: "computer-use", label: "Computer use", description: "Control your computer with screenshots and mouse/keyboard actions." },
          { id: "skills", label: "Skills", description: "Install specialized skill packs for specific workflows." },
          { id: "automations", label: "Automations", description: "Schedule recurring tasks and background agents." },
          { id: "sharing", label: "Share sessions", description: "Share workspace sessions with collaborators via LegalWork Cloud." },
        ],
        hint: "Use settings.panel.open to configure any of these. For example: settings.panel.open({panel:'ai'}) for providers, settings.panel.open({panel:'extensions'}) for MCPs.",
      }),
    },
  ], [navigate]);

  useControlActions(actions);
  return null;
}
