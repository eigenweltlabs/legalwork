import { useMemo } from "react";

import {
  createLegalworkServerClient,
  readLegalworkServerSettings,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";

/**
 * Server client for the task pane's own screens (workspace picker, session
 * list). The pane is served by the LegalWork server itself, so the origin is
 * the API base URL; the token was stored by the bootstrap handshake.
 */
export function useWordServerClient(): LegalworkServerClient {
  return useMemo(() => {
    const settings = readLegalworkServerSettings();
    return createLegalworkServerClient({
      baseUrl: settings.urlOverride ?? window.location.origin,
      token: settings.token,
      hostToken: settings.hostToken,
    });
  }, []);
}
