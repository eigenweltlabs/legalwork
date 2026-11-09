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
  // An explicit installation override remains isolated from production.
  const configured = eigenweltPlatformUrl();
  const allowed = configured === BOOTSTRAP
    ? [BOOTSTRAP, EIGENWELT_DEPLOYMENTS.eu.platform, EIGENWELT_DEPLOYMENTS.us.platform]
    : [configured];
  if (!allowed.includes(normalized)) {
    throw new Error("The Eigenwelt platform URL does not match this LegalWork installation.");
  }
  return normalized;
}

/** Never redirect authenticated traffic or retry it in another region. */
export function eigenweltConnectionPlatformUrl(connection: { platformURL: string | null }): string {
  return connection.platformURL === null ? eigenweltPlatformUrl() : validateEigenweltPlatformUrl(connection.platformURL);
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
