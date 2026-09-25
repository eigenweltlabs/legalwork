import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { OcrSettingsView } from "@legalwork/types/ocr";
import { ApiError } from "../errors.js";
import { createConfiguredOcrService } from "./index.js";
import { isLoopbackOcrEndpoint, OcrSettingsStore, serverEngineSchema } from "./settings.js";
import { OcrRuntime, ocrTestPage } from "./runtime.js";
import { OcrVault, vaultLock } from "./vault.js";

const serverInput = z.strictObject({
  label: serverEngineSchema.shape.label, endpoint: serverEngineSchema.shape.endpoint,
  model: serverEngineSchema.shape.model, languages: serverEngineSchema.shape.languages,
  kind: serverEngineSchema.shape.kind.optional(),
  authentication: z.enum(["api-key", "none"]).optional(),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
});

/** Host-owned configuration, independent of any document tool. Never exposes credentials. */
export class OcrManager {
  readonly store: OcrSettingsStore;
  readonly vault: OcrVault;
  readonly runtime: OcrRuntime;
  private testing = false;
  private startingInstall = false;
  constructor(root: string) {
    this.store = new OcrSettingsStore(join(root, "settings.json"));
    this.vault = new OcrVault(join(root, "keys.vault"));
    this.runtime = new OcrRuntime(root);
  }
  async service() {
    return createConfiguredOcrService(await this.store.read(), {
      localRuntime: this.runtime.local, resolveApiKey: (reference) => this.vault.get(reference),
    });
  }
  async view(readOnly = false): Promise<OcrSettingsView> {
    const settings = await this.store.read();
    const info = createConfiguredOcrService(settings, {
      localRuntime: this.runtime.local, resolveApiKey: (reference) => this.vault.get(reference),
    }).listEngines();
    return {
      defaultEngineId: settings.defaultEngineId, readOnly,
      installerAvailable: await this.runtime.available(), installation: this.runtime.installation,
      engines: await Promise.all(settings.engines.map(async (engine) => {
        const keyConfigured = engine.kind !== "local" && engine.apiKeyRef !== null && Boolean(await this.vault.get(engine.apiKeyRef));
        return {
          id: engine.id, label: engine.label, kind: engine.kind, model: engine.model,
          endpoint: engine.kind !== "local" ? engine.endpoint : undefined,
          authentication: engine.kind === "local" ? undefined : engine.apiKeyRef === null ? "none" : "api-key",
          languages: info.find((item) => item.id === engine.id)?.languages?.slice() ?? null,
          keyConfigured,
          status: engine.kind !== "local" ? (engine.apiKeyRef === null || keyConfigured ? "ready" : "missing-key")
            : !this.runtime.supported(engine.model) ? "unsupported"
            : await this.runtime.ready(engine.model) ? "ready" : "not-installed",
        };
      })),
    };
  }
  async setDefault(id: string) {
    return vaultLock(this.store.path, async () => {
      const settings = await this.store.read();
      const engine = settings.engines.find((item) => item.id === id);
      if (!engine) throw new ApiError(404, "ocr_not_found", "OCR model not found.");
      if (engine.kind === "local" && !this.runtime.supported(engine.model)) throw new ApiError(400, "ocr_unsupported", "This model is not supported on this computer.");
      if (engine.kind === "local" && (this.startingInstall || this.runtime.busy || !await this.runtime.ready(engine.model)))
        throw new ApiError(400, "ocr_not_ready", "Download and finish setting up this model before using it as the default.");
      if (engine.kind !== "local" && engine.apiKeyRef !== null && !await this.vault.get(engine.apiKeyRef))
        throw new ApiError(400, "ocr_key_required", "Add an API key before using this model as the default.");
      await this.store.write({ ...settings, defaultEngineId: id });
    });
  }
  async saveServer(input: unknown, id?: string) {
    const parsed = serverInput.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "ocr_invalid_settings", "Check the name, model, language codes and endpoint. Use HTTPS or loopback HTTP, without URL credentials or query parameters.");
    return vaultLock(this.store.path, async () => {
      const settings = await this.store.read();
      const existing = id ? settings.engines.find((item) => item.id === id) : undefined;
      if (id && (!existing || existing.kind === "local")) throw new ApiError(404, "ocr_not_found", "Custom OCR model not found.");
      const previous = existing && existing.kind !== "local" ? existing : undefined;
      const { apiKey, authentication, kind, ...fields } = parsed.data;
      const useKey = (authentication ?? (previous?.apiKeyRef === null ? "none" : "api-key")) === "api-key";
      if (!useKey && !isLoopbackOcrEndpoint(fields.endpoint))
        throw new ApiError(400, "ocr_key_required", "Authentication can only be disabled for a localhost endpoint.");
      if (!useKey && apiKey) throw new ApiError(400, "ocr_invalid_settings", "Choose API key authentication to save a key.");
      if (useKey && !apiKey && (!previous?.apiKeyRef || new URL(previous.endpoint).origin !== new URL(fields.endpoint).origin))
        throw new ApiError(400, "ocr_key_required", "Enter an API key when adding a model or changing its endpoint address.");
      if (!previous && settings.engines.length >= 32) throw new ApiError(400, "ocr_limit", "Remove a model before adding another.");
      const apiKeyRef = useKey ? apiKey ? `ocr:${randomUUID()}` : previous?.apiKeyRef ?? null : null;
      const engine = serverEngineSchema.parse({ ...fields, id: id ?? `server-${randomUUID()}`, kind: kind ?? previous?.kind ?? "chat-completions", apiKeyRef, maxTokens: previous?.maxTokens });
      if (apiKey && apiKeyRef) await this.vault.set(apiKeyRef, apiKey);
      try {
        await this.store.write({ ...settings, engines: previous ? settings.engines.map((item) => item.id === id ? engine : item) : [...settings.engines, engine] });
      } catch (error) { if (apiKey && apiKeyRef) await this.vault.set(apiKeyRef); throw error; }
      if (previous?.apiKeyRef && previous.apiKeyRef !== apiKeyRef) await this.vault.set(previous.apiKeyRef);
      return engine.id;
    });
  }
  async removeServer(id: string) {
    return vaultLock(this.store.path, async () => {
      const settings = await this.store.read();
      const engine = settings.engines.find((item) => item.id === id);
      if (!engine || engine.kind === "local") throw new ApiError(404, "ocr_not_found", "Custom OCR model not found.");
      await this.store.write({ ...settings, defaultEngineId: settings.defaultEngineId === id ? "local-fast" : settings.defaultEngineId, engines: settings.engines.filter((item) => item.id !== id) });
      if (engine.apiKeyRef) await this.vault.set(engine.apiKeyRef);
    });
  }
  async install(id: string) {
    if (this.testing || this.startingInstall) throw new ApiError(409, "ocr_busy", "Wait for the current OCR operation to finish.");
    this.startingInstall = true;
    try {
      const engine = (await this.store.read()).engines.find((item) => item.id === id);
      if (!engine || engine.kind !== "local") throw new ApiError(404, "ocr_not_found", "Local OCR model not found.");
      await this.runtime.install(engine);
    } finally { this.startingInstall = false; }
  }
  async test(id: string) {
    if (this.runtime.busy || this.testing || this.startingInstall) throw new ApiError(409, "ocr_busy", "Wait for the current OCR operation to finish.");
    this.testing = true;
    try {
      const service = await this.service();
      const engine = service.listEngines().find((item) => item.id === id);
      if (!engine) throw new ApiError(404, "ocr_not_found", "OCR model not found.");
      const result = await service.extract({ sourceId: "ocr-settings-test", engineId: id, languages: engine.languages?.slice(0, 1) ?? ["en"], pages: [await ocrTestPage()] });
      if (!result.pages[0]?.text.trim()) throw new ApiError(502, "ocr_empty_test", "The model returned no text for the sample image.");
      return { ok: true };
    } finally { this.testing = false; }
  }
}
