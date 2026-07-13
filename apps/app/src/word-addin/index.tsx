/** @jsxImportSource react */
import * as React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { setAnalyticsConsentOverride, setAnalyticsDistinctId } from "@/app/lib/analytics";
import { getLegalWorkDeployment } from "@/app/lib/legalwork-deployment";
import { writeLegalworkServerSettings } from "@/app/lib/legalwork-server";
import { bootstrapTheme } from "@/app/theme";
import { initLocale, t } from "@/i18n";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "@/react-app/kernel/platform";
import { AppProviders } from "@/react-app/shell/providers";
import { DEFAULT_SHELL_CONFIG, SHELL_CONFIG_STORAGE_KEY } from "@/react-app/shell/shell-config";
import { officeReady, openLegalworkApp } from "./office";
import { WordAddinRoot } from "./word-addin-root";
import "@/app/index.css";
import "./word-pane.css";

/**
 * The task pane is a slim surface: the agent session UI only. Everything
 * else (settings, providers, workspace management) stays in the LegalWork
 * app. The pane has its own origin-scoped localStorage, so forcing this
 * profile never affects the desktop or web app.
 */
function seedWordPaneShellConfig() {
  try {
    window.localStorage.setItem(
      SHELL_CONFIG_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SHELL_CONFIG,
        sidebar: false,
        statusBar: false,
        welcomePage: false,
        cloudSignin: false,
        browser: false,
        addWorkspace: false,
        notifications: false,
        panelRail: false,
      }),
    );
  } catch {
    // Storage unavailable -- the app still works with its defaults.
  }
}

/**
 * Adopt the desktop's analytics identity (per-launch id + consent) from a
 * bootstrap payload. In-memory only — nothing touches the pane's storage.
 */
function applyAnalyticsIdentity(data: { analyticsDistinctId?: unknown; analyticsEnabled?: unknown }) {
  if (typeof data.analyticsDistinctId === "string") setAnalyticsDistinctId(data.analyticsDistinctId);
  setAnalyticsConsentOverride(data.analyticsEnabled === true);
}

// Re-read the identity every minute so a desktop consent change reaches an
// already-open pane.
const ANALYTICS_IDENTITY_POLL_MS = 60_000;
let analyticsIdentityPollStarted = false;
function startAnalyticsIdentityPoll() {
  if (analyticsIdentityPollStarted) return;
  analyticsIdentityPollStarted = true;
  setInterval(() => {
    void fetch("/word-addin/bootstrap", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<Record<string, unknown>>) : null))
      .then((data) => {
        if (data) applyAnalyticsIdentity(data);
      })
      .catch(() => undefined);
  }, ANALYTICS_IDENTITY_POLL_MS);
}

/**
 * Pair with the server that serves this page. The bootstrap endpoint is
 * same-origin only and hands out the current client token, so the pane
 * survives server restarts with rotated tokens.
 */
async function connectToServer(): Promise<void> {
  const response = await fetch("/word-addin/bootstrap", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Bootstrap failed with status ${response.status}`);
  }
  const data = (await response.json()) as {
    token?: unknown;
    hostToken?: unknown;
    analyticsDistinctId?: unknown;
    analyticsEnabled?: unknown;
  };
  const token = typeof data.token === "string" ? data.token.trim() : "";
  if (!token) {
    throw new Error("Bootstrap response did not include a token");
  }
  const hostToken = typeof data.hostToken === "string" ? data.hostToken.trim() : "";
  writeLegalworkServerSettings({
    urlOverride: window.location.origin,
    token,
    hostToken: hostToken || undefined,
  });
  // Adopt the desktop's analytics identity BEFORE analytics initializes; keep
  // polling for changes.
  applyAnalyticsIdentity(data);
  startAnalyticsIdentityPoll();
  // Shell updates are handled by the shell itself (version check against
  // the bootstrap response + self-reload; see server word-addin-shell.ts).
  // A subresource fetch here cannot refresh the navigation cache entry.
}

type ConnectionState =
  | { status: "connecting" }
  | { status: "ready" }
  | { status: "error"; message: string };

function ConnectScreen({ state, onRetry }: { state: ConnectionState; onRetry: () => void }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      {state.status === "connecting" ? (
        <p className="text-sm text-dls-secondary">{t("word_addin.connecting")}</p>
      ) : (
        <>
          <p className="text-sm font-medium text-dls-text">{t("word_addin.connect_error_title")}</p>
          <p className="max-w-xs text-xs leading-relaxed text-dls-secondary">
            {t("word_addin.connect_error_body")}
          </p>
          {state.status === "error" ? (
            <p className="max-w-xs break-all text-[11px] text-dls-secondary/80">{state.message}</p>
          ) : null}
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="rounded-full bg-dls-accent px-4 py-1.5 text-xs font-medium text-[var(--dls-accent-fg)] transition-colors hover:bg-[var(--dls-accent-hover)]"
              onClick={() => openLegalworkApp()}
            >
              {t("word_addin.open_legalwork")}
            </button>
            <button
              type="button"
              className="rounded-full border border-dls-border bg-dls-surface px-4 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
              onClick={onRetry}
            >
              {t("word_addin.connect_retry")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const platform = createDefaultPlatform();
const queryClient = getReactQueryClient();

function WordAddinApp() {
  const [state, setState] = React.useState<ConnectionState>({ status: "connecting" });

  const connect = React.useCallback(() => {
    setState({ status: "connecting" });
    void connectToServer()
      .then(() => setState({ status: "ready" }))
      .catch((error: unknown) => {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  React.useEffect(() => {
    connect();
  }, [connect]);

  if (state.status !== "ready") {
    return <ConnectScreen state={state} onRetry={connect} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PlatformProvider value={platform}>
          <AppProviders>
            <HashRouter>
              <WordAddinRoot />
            </HashRouter>
          </AppProviders>
        </PlatformProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

bootstrapTheme();
initLocale();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Task pane root element not found");
}
root.dataset.legalworkDeployment = getLegalWorkDeployment();
// Scope hook for the pane-only compact styles in word-pane.css.
document.documentElement.classList.add("lw-word-pane");

// Office.js must finish initializing before the app renders; outside Word
// this resolves immediately and the pane behaves like a plain web client.
void officeReady().finally(() => {
  seedWordPaneShellConfig();
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <WordAddinApp />
    </React.StrictMode>,
  );
});
