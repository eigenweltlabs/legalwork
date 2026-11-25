/**
 * Error reporting from LegalWork's desktop windows.
 *
 * Sentry's Electron SDK forwards everything captured here to the main
 * process, which cleans each event and sends it only while the user's
 * "share anonymous usage" setting (and the firm policy) allows it; see
 * apps/desktop/electron/error-reporting.mjs. Outside the desktop app (Office
 * panes, the browser dev server) nothing is captured.
 */
type SentryRenderer = typeof import("@sentry/electron/renderer");

let sentry: SentryRenderer | null = null;
let starting: Promise<void> | null = null;

function isDesktopWindow(): boolean {
  return typeof window !== "undefined" && Boolean(window.__LEGALWORK_ELECTRON__);
}

/** Start capturing uncaught errors and unhandled rejections in this window. Idempotent. */
export function initDesktopErrorReporting(): Promise<void> {
  if (!isDesktopWindow()) return Promise.resolve();
  starting ??= import("@sentry/electron/renderer")
    .then((module) => {
      // Release, environment, filtering and sending are configured in the main process.
      module.init({});
      sentry = module;
    })
    .catch(() => {
      sentry = null;
    });
  return starting;
}

/** Report an error that the app caught (for example a failed action shown to the user). Never throws. */
export function reportError(error: unknown, context: { source: string; tags?: Record<string, string> }): void {
  try {
    sentry?.captureException(error, { tags: { source: context.source, ...context.tags } });
  } catch {
    // Error reporting must never surface an error itself.
  }
}

/** Tell the main process whether error reports may be sent. */
export function syncErrorReportingConsent(enabled: boolean): void {
  try {
    window.__LEGALWORK_ELECTRON__?.setErrorReportingConsent?.(enabled);
  } catch {
    // The previous choice stays in effect.
  }
}
