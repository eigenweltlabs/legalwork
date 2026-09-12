import { googleDriveProvider } from "./google-drive.js";
import type { StorageInput, StorageOAuthProvider } from "@legalwork/types/file-storage";
import type { StorageAdapter } from "../common.js";
import { ApiError } from "../../errors.js";

export type OAuthConfig = Extract<StorageInput["config"], { kind: "oauth" }>;
export type AccessToken = () => Promise<string>;
export type OAuthProvider = StorageOAuthProvider & {
  clientId: string;
  /** Only installed-app credentials, never a confidential web client secret. */
  clientSecret?: string;
  clientSecretRequired?: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: (readOnly: boolean) => string[];
  authorizeParams?: Record<string, string>;
  port?: number;
  adapter: (config: OAuthConfig, token: AccessToken) => Promise<StorageAdapter> | StorageAdapter;
};
// Each provider branch adds its own registration to this shared entry point.
export const oauthProviders: OAuthProvider[] = [googleDriveProvider];
export function oauthProvider(id: string) {
  const provider = oauthProviders.find((item) => item.id === id);
  if (!provider?.clientId)
    throw new ApiError(409, "storage_provider_unavailable", "This connection is not available in this version of LegalWork.");
  if (provider.clientSecretRequired && !provider.clientSecret)
    throw new ApiError(409, "storage_signin_unavailable", "Sign-in is unavailable in this build. Install a current official build of LegalWork.");
  return provider;
}
