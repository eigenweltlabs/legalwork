import type { LegalworkServerCapabilities } from "../../app/lib/legalwork-server";

/**
 * What a connected LegalWork server workspace is assumed to expose. The
 * settings route and the onboarding permissions step both drive config
 * panels from it, so it lives here instead of being restated per route.
 */
export const ROUTE_LEGALWORK_CAPABILITIES: LegalworkServerCapabilities = {
  skills: { read: true, write: true, source: "legalwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};
