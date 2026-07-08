import {
  isLoopbackLegalworkServerUrl,
  normalizeLegalworkServerUrl,
  readLegalworkServerSettings,
} from "../../app/lib/legalwork-server";
import { legalworkServerInfo, type LegalworkServerInfo } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";

export type LegalworkConnectionSource = "desktop-runtime" | "stored-settings" | "empty";

export type ResolvedLegalworkConnection = {
  normalizedBaseUrl: string;
  resolvedToken: string;
  resolvedHostToken: string;
  hostInfo: LegalworkServerInfo | null;
  source: LegalworkConnectionSource;
};

function hasUsableConnection(url: string, token: string) {
  return url.trim().length > 0 && token.trim().length > 0;
}

/**
 * Resolve the LegalWork server connection for routes that consume the server API.
 *
 * Local desktop-hosted servers expose ephemeral loopback ports and freshly
 * minted tokens on every boot, so live runtime info is the source of truth
 * there. Stored settings remain the fallback for remote/manual server
 * connections and for desktop cases where the runtime bridge is unavailable.
 */
export async function resolveLegalworkConnection(): Promise<ResolvedLegalworkConnection> {
  let staleDesktopRuntimeBaseUrl = "";
  let desktopRuntimeReportedDown = false;

  if (isDesktopRuntime()) {
    try {
      const info = await legalworkServerInfo() as LegalworkServerInfo;
      const normalizedBaseUrl =
        normalizeLegalworkServerUrl(info.baseUrl ?? info.connectUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
        "";
      const resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || "";
      if (info.running === true && hasUsableConnection(normalizedBaseUrl, resolvedToken)) {
        return {
          normalizedBaseUrl,
          resolvedToken,
          resolvedHostToken: info.hostToken?.trim() || "",
          hostInfo: info,
          source: "desktop-runtime",
        };
      }
      staleDesktopRuntimeBaseUrl = normalizedBaseUrl;
      // The bridge answered and the local server is not (yet) up. Any stored
      // loopback URL can only point at a previous local server process, so it
      // must not be used as a fallback below.
      desktopRuntimeReportedDown = true;
    } catch {
      // Fall through to stored settings for remote/manual connections.
    }
  }

  const settings = readLegalworkServerSettings();
  const normalizedBaseUrl = normalizeLegalworkServerUrl(settings.urlOverride ?? "") ?? "";
  const resolvedToken = settings.token?.trim() ?? "";
  const resolvedHostToken =
    normalizedBaseUrl && isLoopbackLegalworkServerUrl(normalizedBaseUrl)
      ? settings.hostToken?.trim() ?? ""
      : "";
  const storedConnectionIsStaleDesktopRuntime = Boolean(
    isDesktopRuntime() &&
      staleDesktopRuntimeBaseUrl &&
      normalizedBaseUrl === staleDesktopRuntimeBaseUrl,
  );
  // Local ports/tokens are ephemeral per app boot. While the desktop runtime
  // says the local server is down (typically during startup, before the boot
  // sequence publishes fresh settings), a persisted loopback URL is guaranteed
  // stale — firing requests at it only produces ERR_CONNECTION_REFUSED spam.
  // Resolve as "empty" instead; routes re-resolve on the
  // "legalwork-server-settings-changed" event once the server is up.
  const storedLoopbackWhileLocalServerDown = Boolean(
    desktopRuntimeReportedDown &&
      normalizedBaseUrl &&
      isLoopbackLegalworkServerUrl(normalizedBaseUrl),
  );
  const source =
    !storedConnectionIsStaleDesktopRuntime &&
    !storedLoopbackWhileLocalServerDown &&
    hasUsableConnection(normalizedBaseUrl, resolvedToken)
      ? "stored-settings"
      : "empty";

  return {
    normalizedBaseUrl: source === "empty" ? "" : normalizedBaseUrl,
    resolvedToken: source === "empty" ? "" : resolvedToken,
    resolvedHostToken: source === "empty" ? "" : resolvedHostToken,
    hostInfo: null,
    source,
  };
}
