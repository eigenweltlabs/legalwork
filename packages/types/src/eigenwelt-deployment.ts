/** First-party routing contract shared by the app and its local server. */
export const EIGENWELT_BOOTSTRAP_PLATFORM_URL = "https://platform.eigenweltlabs.com";
export const EIGENWELT_LEGACY_GATEWAY_URL = "https://api.eigenweltlabs.com";
export const EIGENWELT_DEPLOYMENTS = {
  eu: { platform: "https://eu.platform.eigenweltlabs.com", gateway: "https://eu.platform.eigenweltlabs.com/v1", api: "https://eu.api.eigenweltlabs.com" },
  us: { platform: "https://us.platform.eigenweltlabs.com", gateway: "https://us.platform.eigenweltlabs.com/v1", api: "https://us.api.eigenweltlabs.com" },
};
export type EigenweltDeploymentRegion = keyof typeof EIGENWELT_DEPLOYMENTS;
