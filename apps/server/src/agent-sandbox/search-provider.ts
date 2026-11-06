import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { eigenweltHasPremiumModels } from "../eigenwelt-auth.js";
import { readCachedEigenweltPaidManifest } from "../eigenwelt-paid-manifest.js";
import type { ServerConfig } from "../types.js";

export type SearchProvider = { name: "exa" } | { name: "aws"; url: string; apiKey: string };

/** Resolve on the server, independently of the model selected in the chat. */
export async function searchProvider(config: ServerConfig): Promise<SearchProvider> {
  const connection = await readEigenweltConnection(config);
  if (!eigenweltHasPremiumModels(connection.entitlements)) return { name: "exa" };
  const manifest = await readCachedEigenweltPaidManifest(config);
  if (!manifest) throw new Error("Sign in again to restore your paid web search connection.");
  const url = new URL(manifest.baseURL);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("The paid web search gateway URL is invalid.");
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/v1/web/search";
  return { name: "aws", url: url.href, apiKey: manifest.apiKey };
}
