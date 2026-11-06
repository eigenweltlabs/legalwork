import { z } from "zod";
import { ApiError } from "./errors.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { readCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import type { EigenweltManifestModel } from "./eigenwelt-auth.js";
import type { ServerConfig } from "./types.js";

const RemoteSchema = z.object({
  baseURL: z.string().url(),
  models: z.array(z.object({ model: z.enum(["gemini-transcribe-live-eu", "gemini-transcribe-live-us"]),
    name: z.string(), region: z.enum(["EU", "US"]), enabled: z.boolean(), available: z.boolean() })),
});

export function defaultMeetingNotesModel(models: EigenweltManifestModel[], region: string) {
  return models.find(model => model.region?.toUpperCase() === region.toUpperCase()
    && [model.id, model.name, model.upstreamModel].some(name => /\b(?:openai|gpt)\b.*\bluna\b/i.test(name ?? "")));
}

async function remoteConfiguration(config: ServerConfig) {
  const token = await ensureFreshPlatformToken(config);
  const connection = await readEigenweltConnection(config);
  if (!token || !connection.platformURL) return null;
  const response = await fetch(`${connection.platformURL}/api/desktop/transcription`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const parsed = RemoteSchema.safeParse(await response.json());
  return parsed.success ? { remote: parsed.data, orgId: connection.account?.orgId, token } : null;
}

export async function cloudTranscriptionStatus(config: ServerConfig) {
  try {
    const result = await remoteConfiguration(config);
    const manifest = result ? await readCachedEigenweltPaidManifest(config) : null;
    const summaryModels = (manifest?.models ?? []).flatMap(model => model.region && ["EU", "US"].includes(model.region.toUpperCase())
      ? [{ model: model.id, name: model.name ?? model.id, region: model.region.toUpperCase() }] : []);
    const defaultSummaryModels = {
      EU: defaultMeetingNotesModel(manifest?.models ?? [], "EU")?.id,
      US: defaultMeetingNotesModel(manifest?.models ?? [], "US")?.id,
    };
    return { models: result?.remote.models ?? [], summaryModels, defaultSummaryModels, error: null };
  } catch {
    return { models: [], error: "Cloud transcription is currently unavailable." };
  }
}

/** Only the trusted desktop main process asks for this authenticated transport. */
export async function cloudTranscriptionConnection(config: ServerConfig, model: string) {
  const result = await remoteConfiguration(config);
  const manifest = await readCachedEigenweltPaidManifest(config);
  const connection = await readEigenweltConnection(config);
  if (!result || !manifest || connection.account?.orgId !== result.orgId || connection.platformToken !== result.token) {
    throw new ApiError(403, "transcription_unavailable", "Sign in to your Eigenwelt account to use cloud transcription.");
  }
  const selected = result.remote.models.find(item => item.model === model && item.enabled && item.available);
  if (!selected) throw new ApiError(403, "transcription_disabled", "Your organisation has not enabled this cloud transcription model.");
  const gateway = new URL(result.remote.baseURL);
  const paid = new URL(manifest.baseURL);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname);
  if (gateway.origin !== paid.origin || gateway.username || gateway.password || (gateway.protocol !== "https:" && !(loopback && gateway.protocol === "http:"))) {
    throw new ApiError(503, "transcription_unavailable", "Cloud transcription is currently unavailable.");
  }
  gateway.pathname = "/v1/transcription/live";
  gateway.search = "";
  gateway.hash = "";
  gateway.protocol = gateway.protocol === "https:" ? "wss:" : "ws:";
  gateway.searchParams.set("model", selected.model);
  return { url: gateway.toString(), apiKey: manifest.apiKey, model: selected.model, region: selected.region };
}
