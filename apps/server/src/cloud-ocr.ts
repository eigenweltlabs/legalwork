import { z } from "zod";
import { OcrError } from "./ocr/types.js";
import { ApiError } from "./errors.js";
import { eigenweltConnectionPlatformUrl } from "./eigenwelt-endpoints.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { readCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { createServerOcrEngine } from "./ocr/server-engine.js";
import type { CloudOcrRuntime } from "./ocr/index.js";
import type { ServerConfig } from "./types.js";

const configuration = z.object({ baseURL: z.url(), models: z.array(z.object({
  model: z.enum(["google-document-ocr-eu", "google-document-ocr-us"]), name: z.string(),
  region: z.enum(["EU", "US"]), enabled: z.boolean(), available: z.boolean(),
  serverId: z.string(), tool: z.literal("recognize_page"),
})).max(2).refine(models => new Set(models.map(model => model.model)).size === models.length
  && models.every(model => model.model.endsWith(`-${model.region.toLowerCase()}`))) });

async function connection(config: ServerConfig) {
  await ensureFreshPlatformToken(config);
  const before = await readEigenweltConnection(config);
  if (!before.platformToken || !before.platformURL) return null;
  const response = await fetch(`${eigenweltConnectionPlatformUrl(before)}/api/desktop/ocr`, {
    headers: { Authorization: `Bearer ${before.platformToken}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(503, "cloud_ocr_unavailable", "Cloud OCR is currently unavailable."); }
  const remote = configuration.parse(await response.json());
  const manifest = await readCachedEigenweltPaidManifest(config);
  const current = await readEigenweltConnection(config);
  if (!manifest || current.platformToken !== before.platformToken || current.account?.orgId !== before.account?.orgId) return null;
  const base = new URL(remote.baseURL), paid = new URL(manifest.baseURL);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.origin !== paid.origin || base.username || base.password || base.search || base.hash
      || (base.protocol !== "https:" && !(loopback && base.protocol === "http:")))
    throw new ApiError(503, "cloud_ocr_unavailable", "Cloud OCR is currently unavailable.");
  return { remote, manifest, base };
}

/** Live firm permission is checked before each page, and again by the Gateway. */
export function cloudOcrRuntime(config: ServerConfig): CloudOcrRuntime {
  return {
    async status(model) {
      try {
        const value = await connection(config);
        if (!value) return "disconnected";
        const selected = value.remote.models.find(item => item.model === model);
        return !selected?.available ? "unavailable" : selected.enabled ? "ready" : "disabled";
      } catch { return "unavailable"; }
    },
    async recognize(model, page, context) {
      let value;
      try { value = await connection(config); } catch { throw new OcrError("server-failed", "Cloud OCR is currently unavailable."); }
      if (!value) throw new OcrError("server-failed", "Sign in with Eigenwelt to use cloud OCR.");
      const selected = value.remote.models.find(item => item.model === model && item.enabled && item.available);
      if (!selected) throw new OcrError("server-failed", "Your organization has not enabled this cloud OCR model.");
      value.base.pathname = "/mcp-rest/tools/call";
      const engine = createServerOcrEngine({ id: `cloud-google-${selected.region.toLowerCase()}`, kind: "mcp-ocr",
        label: selected.name, model: `${selected.serverId}/${selected.tool}`, endpoint: value.base.href,
        apiKeyRef: "managed:cloud-ocr", languages: null, maxTokens: 8192 }, async () => value.manifest.apiKey);
      return engine.recognize(page, context);
    },
  };
}
