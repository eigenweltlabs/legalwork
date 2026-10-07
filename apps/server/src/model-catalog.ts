import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { modelCatalogBaseURL, modelCatalogSchema, providerModelsFromCatalog } from "./provider-model-catalog.js";
import { serve } from "./serve-node.js";
import type { ServerConfig } from "./types.js";

export const modelCatalogSettingsSchema = z.strictObject({ onlineUpdatesEnabled: z.boolean() });
const cacheSchema = z.object({ fetchedAt: z.number(), catalog: modelCatalogSchema });
const REFRESH_MS = 60 * 60 * 1000;
type CatalogCache = z.infer<typeof cacheSchema>;

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** One persisted switch gates both engine background refreshes and user refreshes. */
export class ModelCatalog {
  private enabled = false;
  private cached: CatalogCache | undefined;
  private loaded: Promise<void>;
  private pending: Promise<CatalogCache["catalog"]> | undefined;
  private controller: AbortController | undefined;
  private attemptedAt = 0;
  private settingsWrite: Promise<void> = Promise.resolve();

  constructor(private directory: string, private fetchCatalog: (url: string, options: RequestInit) => Promise<Response> = fetch) {
    this.loaded = this.load();
  }

  private async load() {
    try {
      const settings = modelCatalogSettingsSchema.parse(JSON.parse(await readFile(join(this.directory, "model-catalog-settings.json"), "utf8")));
      this.enabled = settings.onlineUpdatesEnabled;
    } catch (error) {
      // A damaged/unreadable preference must never silently re-enable traffic.
      this.enabled = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!this.enabled) console.warn("[model-catalog] Saved settings could not be read; online updates disabled.");
    }
    try {
      this.cached = cacheSchema.parse(JSON.parse(await readFile(join(this.directory, "model-catalog.json"), "utf8")));
    } catch { /* A missing or damaged public cache uses the engine's bundled catalog. */ }
  }

  async settings() {
    await this.loaded;
    return { onlineUpdatesEnabled: this.enabled };
  }

  async saveSettings(input: z.infer<typeof modelCatalogSettingsSchema>) {
    const settings = modelCatalogSettingsSchema.parse(input);
    const write = this.settingsWrite.then(async () => {
      await this.loaded;
      if (!settings.onlineUpdatesEnabled) {
        this.enabled = false;
        this.controller?.abort();
      }
      await writeJson(join(this.directory, "model-catalog-settings.json"), settings);
      this.enabled = settings.onlineUpdatesEnabled;
      this.attemptedAt = 0;
    });
    this.settingsWrite = write.catch(() => {});
    await write;
    return this.settings();
  }

  async providerModels(providerId: string) {
    if (!(await this.settings()).onlineUpdatesEnabled) {
      throw new ApiError(409, "model_catalog_updates_disabled", "Online model list updates are disabled. Enable them in Settings → Privacy to refresh models.");
    }
    return providerModelsFromCatalog(providerId, await this.get(true));
  }

  async get(refresh = false): Promise<CatalogCache["catalog"]> {
    await this.loaded;
    if (!this.enabled) return this.offline();
    if (!refresh && this.cached && Date.now() - this.cached.fetchedAt < REFRESH_MS) return this.cached.catalog;
    if (!this.pending) {
      if (!refresh && Date.now() - this.attemptedAt < 60_000) return this.offline();
      this.pending = this.refresh().finally(() => { this.pending = undefined; });
    }
    try { return await this.pending; }
    catch (error) {
      if (refresh) throw error;
      return this.offline();
    }
  }

  private offline() {
    if (this.cached) return this.cached.catalog;
    throw new Error("No saved model catalog is available. The engine can use its bundled model list.");
  }

  private async refresh() {
    const controller = new AbortController();
    this.controller = controller;
    this.attemptedAt = Date.now();
    try {
      const response = await this.fetchCatalog(`${modelCatalogBaseURL()}/api.json`, {
        cache: "no-store", redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`Model catalog unavailable (HTTP ${response.status}).`);
      const catalog = modelCatalogSchema.parse(await response.json());
      controller.signal.throwIfAborted();
      this.cached = { fetchedAt: Date.now(), catalog };
      await writeJson(join(this.directory, "model-catalog.json"), this.cached).catch(() => {
        console.warn("[model-catalog] Could not save the public catalog cache.");
      });
      return catalog;
    } finally { this.controller = undefined; }
  }
}

const catalogs = new WeakMap<ServerConfig, ModelCatalog>();
export function modelCatalogFor(config: ServerConfig) {
  let catalog = catalogs.get(config);
  if (!catalog) {
    const directory = config.configPath ? dirname(resolve(config.configPath)) : join(homedir(), ".config", "legalwork");
    catalog = new ModelCatalog(directory);
    catalogs.set(config, catalog);
  }
  return catalog;
}

export async function modelCatalogResponse(catalog: ModelCatalog) {
  try { return Response.json(await catalog.get(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "model catalog unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}

/** Started before the engine so its initial refresh also respects the saved switch. */
export async function startModelCatalogRelay(config: ServerConfig) {
  const catalog = modelCatalogFor(config);
  await catalog.settings();
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/api.json") return new Response(null, { status: 404 });
    return modelCatalogResponse(catalog);
  } });
  return { url: `http://127.0.0.1:${server.port}`, stop: server.stop };
}
