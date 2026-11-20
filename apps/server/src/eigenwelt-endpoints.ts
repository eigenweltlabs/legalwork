import { EIGENWELT_BOOTSTRAP_PLATFORM_URL as BOOTSTRAP, EIGENWELT_DEPLOYMENTS } from "./native-shared-values.js";
export { EIGENWELT_DEPLOYMENTS, type EigenweltDeploymentRegion } from "./native-shared-values.js";

/** Only sign-in discovery and the public catalog use the shared entry point. */
export function eigenweltPlatformUrl(): string {
  return (process.env.EIGENWELT_PLATFORM_URL ?? BOOTSTRAP).replace(/\/+$/, "");
}

export function validateEigenweltPlatformUrl(value: string): string {
  let candidate: URL;
  try { candidate = new URL(value.trim()); }
  catch { throw new Error("Invalid Eigenwelt platform URL."); }
  if (candidate.username || candidate.password || candidate.search || candidate.hash) {
    throw new Error("Invalid Eigenwelt platform URL.");
  }
  const normalized = candidate.toString().replace(/\/+$/, "");
  // Custom installations stay isolated. Regional discovery during development
  // requires both explicit dev flags and an approved test entry point.
  const configured = eigenweltPlatformUrl();
  const regionalDevelopment = process.env.LEGALWORK_DEV_MODE === "1" &&
    process.env.LEGALWORK_DEV_REGIONAL_ROUTING === "1" &&
    [EIGENWELT_DEPLOYMENTS.eu.platform, EIGENWELT_DEPLOYMENTS.us.platform,
      "http://127.0.0.1:3006"].includes(configured);
  const allowed = regionalDevelopment
    ? [configured, EIGENWELT_DEPLOYMENTS.eu.platform, EIGENWELT_DEPLOYMENTS.us.platform]
    : configured === BOOTSTRAP
      ? [BOOTSTRAP, EIGENWELT_DEPLOYMENTS.eu.platform, EIGENWELT_DEPLOYMENTS.us.platform]
      : [configured];
  if (!allowed.includes(normalized)) {
    throw new Error("The Eigenwelt platform URL does not match this LegalWork installation.");
  }
  return normalized;
}

/** Stable account origin, also used to scope local connector and sync data. */
export function eigenweltConnectionIdentityUrl(connection: { platformURL: string | null }): string {
  return connection.platformURL === null ? eigenweltPlatformUrl() : validateEigenweltPlatformUrl(connection.platformURL);
}

/** Never redirect authenticated traffic or retry it in another region. */
export function eigenweltConnectionPlatformUrl(connection: { platformURL: string | null; regionalPlatformURL?: string | null }): string {
  const origin = eigenweltConnectionIdentityUrl(connection);
  if (origin === BOOTSTRAP && connection.regionalPlatformURL && eigenweltPlatformUrl() === BOOTSTRAP) {
    const regional = validateEigenweltPlatformUrl(connection.regionalPlatformURL);
    if (Object.values(EIGENWELT_DEPLOYMENTS).some(deployment => deployment.platform === regional)) return regional;
  }
  return origin;
}

/** Read placement only from a successful refresh at the trusted shared origin.
 * This does not authenticate a JWT: TLS authenticates the refresh response and
 * the destination still verifies the token and membership. Never use these
 * decoded claims to grant access or accept a token from an incoming request. */
export function eigenweltRefreshPlatformUrl(connection: {
  platformURL: string | null;
  regionalPlatformURL?: string | null;
  account: { userId: string; orgId: string } | null;
}, token: string): string | undefined {
  if (eigenweltPlatformUrl() !== BOOTSTRAP || eigenweltConnectionPlatformUrl(connection) !== BOOTSTRAP || !connection.account) return;
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16_384 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims) ||
        !("iss" in claims) || claims.iss !== "eigenwelt-platform" ||
        !("aud" in claims) || claims.aud !== "legalwork-desktop" ||
        !("sub" in claims) || claims.sub !== connection.account.userId ||
        !("org" in claims) || claims.org !== connection.account.orgId ||
        !("deploymentRoutingVersion" in claims) || claims.deploymentRoutingVersion !== 1 ||
        !("deploymentRegion" in claims)) return;
    if (claims.deploymentRegion === "eu" || claims.deploymentRegion === "us") {
      return validateEigenweltPlatformUrl(EIGENWELT_DEPLOYMENTS[claims.deploymentRegion].platform);
    }
  } catch { /* Older/malformed tokens keep the working compatibility route. */ }
}

/** The original unpredictable state is retained, with only an allowlisted region suffix.
 * PKCE and the target platform's single-use SQL session still authenticate exchange. */
export function eigenweltCallbackPlatform(expectedState: string, receivedState: string | null): string | null {
  if (receivedState === expectedState) return eigenweltPlatformUrl();
  for (const region of ["eu", "us"]) {
    const target = region === "eu" ? EIGENWELT_DEPLOYMENTS.eu.platform : EIGENWELT_DEPLOYMENTS.us.platform;
    if (receivedState === `${expectedState}.${region}`) {
      try { return validateEigenweltPlatformUrl(target); } catch { return null; }
    }
  }
  return null;
}
