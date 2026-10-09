import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { OcrSettingsView } from "@legalwork/types/ocr";
import { ApiError } from "../errors.js";
import { createConfiguredOcrService } from "./index.js";
import { isLoopbackOcrEndpoint, OcrSettingsStore, serverEngineSchema, type OcrSettings, type ServerEngineSettings } from "./settings.js";
import type { OcrSecretResolver } from "./server-engine.js";
import { OcrRuntime, ocrTestPage } from "./runtime.js";
import { layoutModelAsset } from "./models.js";
import { OcrVault, vaultLock } from "./vault.js";

const serverInput = z.strictObject({
  label: serverEngineSchema.shape.label, endpoint: serverEngineSchema.shape.endpoint,
  model: serverEngineSchema.shape.model, languages: serverEngineSchema.shape.languages,
  kind: serverEngineSchema.shape.kind.optional(),
  authentication: z.enum(["api-key", "none"]).optional(),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
});

/**
 * What the firm's policy adds: its engines (the firm's keys resolve through
 * `org:` references, a member's own through `member:` ones in the vault), its
 * default, and whether members may add their own.
 */
export type FirmOcr = {
  engines: Array<ServerEngineSettings & { firmKey: "firm" | "member" }>;
  defaultEngineId: string | null;
  allowCustom: boolean;
  resolveFirmKey: OcrSecretResolver;
};

export const memberKeyRef = (engineId: string) => `member:${engineId}`;

/** Host-owned configuration, independent of any document tool. Never exposes credentials. */
export class OcrManager {
  readonly store: OcrSettingsStore;
  readonly vault: OcrVault;
  readonly runtime: OcrRuntime;
  private testing = false;
  private startingInstall = false;
  private automaticAttempted = false;
  private automaticPending = false;
  private automaticCancelled = false;
  private stopped = false;
  constructor(root: string, private readonly firm?: () => Promise<FirmOcr>) {
    this.store = new OcrSettingsStore(join(root, "settings.json"));
    this.vault = new OcrVault(join(root, "keys.vault"));
    this.runtime = new OcrRuntime(root);
  }
  /** The member's settings with the firm's engines and default applied, and no own servers while the firm allows none. */
  private async effective(): Promise<{ settings: OcrSettings; resolveApiKey: OcrSecretResolver; firmKeys: Map<string, "firm" | "member"> }> {
    const settings = await this.store.read();
    const own: OcrSecretResolver = (reference) => this.vault.get(reference);
    const firm = await this.firm?.();
    if (!firm) return { settings, resolveApiKey: own, firmKeys: new Map() };
    const engines = [
      ...settings.engines.filter((engine) => (engine.kind === "local" || firm.allowCustom) && !firm.engines.some((each) => each.id === engine.id)),
      ...firm.engines.map(({ firmKey: _firmKey, ...engine }) => engine),
    ];
    const ids = engines.map((engine) => engine.id);
    const defaultEngineId = firm.defaultEngineId && ids.includes(firm.defaultEngineId) ? firm.defaultEngineId
      : ids.includes(settings.defaultEngineId) ? settings.defaultEngineId : "local-fast";
    return {
      settings: { ...settings, engines, defaultEngineId },
      resolveApiKey: (reference) => (reference.startsWith("org:") ? firm.resolveFirmKey(reference.slice("org:".length)) : own(reference)),
      firmKeys: new Map(firm.engines.map((engine) => [engine.id, engine.firmKey])),
    };
  }
  async service() {
    const { settings, resolveApiKey } = await this.effective();
    return createConfiguredOcrService(settings, { localRuntime: this.runtime.local, resolveApiKey });
  }
  async view(readOnly = false): Promise<OcrSettingsView> {
    const { settings, resolveApiKey, firmKeys } = await this.effective();
    const info = createConfiguredOcrService(settings, { localRuntime: this.runtime.local, resolveApiKey }).listEngines();
    return {
      defaultEngineId: settings.defaultEngineId, readOnly,
      installerAvailable: await this.runtime.available(), installation: this.runtime.installation ?? (this.automaticPending ? { engineId: "local-fast", stage: "runtime" } : null),
      layout: { model: "pp-doclayout-v3-onnx", bytes: layoutModelAsset.bytes, status: await this.runtime.layoutReady() ? "ready" : "not-installed" },
      engines: await Promise.all(settings.engines.map(async (engine) => {
        const keyConfigured = engine.kind !== "local" && engine.apiKeyRef !== null && Boolean(await resolveApiKey(engine.apiKeyRef));
        return {
          id: engine.id, label: engine.label, kind: engine.kind, model: engine.model,
          endpoint: engine.kind !== "local" ? engine.endpoint : undefined,
          authentication: engine.kind === "local" ? undefined : engine.apiKeyRef === null ? "none" : "api-key",
          languages: info.find((item) => item.id === engine.id)?.languages?.slice() ?? null,
          keyConfigured,
          firmKey: firmKeys.get(engine.id),
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
    if ((await this.firm?.())?.allowCustom === false) throw new ApiError(403, "org_policy_disallowed", "Your organization does not allow adding OCR providers.");
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
  /** The member's own key for one of the firm's engines that asks for it; none removes it. */
  async setMemberKey(id: string, apiKey: string | null) {
    const engine = (await this.firm?.())?.engines.find((each) => each.id === id);
    if (engine?.firmKey !== "member") throw new ApiError(404, "ocr_not_found", "Your firm does not ask for your own key for this engine.");
    await this.vault.set(memberKeyRef(id), apiKey ?? undefined);
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
  /** Once per launch, without blocking server startup or changing the selected provider. */
  async downloadDefaultIfNeeded() {
    if (this.automaticAttempted || this.stopped) return;
    this.automaticAttempted = true; this.automaticPending = true;
    let target: string | undefined = "local-fast";
    try {
      const settings = await this.store.read();
      if (await access(join(this.runtime.root, "auto-download-cancelled")).then(() => true, () => false)) return;
      target = settings.defaultEngineId === "local-fast" && !await this.runtime.ready("pp-ocrv6-small")
        ? "local-fast" : !await this.runtime.layoutReady() ? "local-layout" : undefined;
      if (!target) return;
      if (this.stopped || this.automaticCancelled || this.testing || this.startingInstall || this.runtime.busy) return;
      await this.install(target, true);
    } catch {
      if (!this.stopped && !this.runtime.busy) this.runtime.installation = { engineId: target ?? "local-layout", stage: "failed" };
    } finally { this.automaticPending = false; }
  }
  async cancelInstall() {
    this.automaticCancelled = true;
    if (this.automaticPending && !this.runtime.busy) this.runtime.installation = { engineId: "local-fast", stage: "cancelled" };
    if (this.automaticPending || (this.runtime.busy && ["local-fast", "local-layout"].includes(this.runtime.installation?.engineId ?? ""))) {
      await mkdir(this.runtime.root, { recursive: true, mode: 0o700 });
      await writeFile(join(this.runtime.root, "auto-download-cancelled"), "1\n", { mode: 0o600 });
    }
    this.runtime.cancel();
  }
  stop() { this.stopped = true; this.runtime.cancel(); }
  async install(id: string, automatic = false) {
    if (this.stopped || this.testing || this.startingInstall) throw new ApiError(409, "ocr_busy", "Wait for the current OCR operation to finish.");
    this.startingInstall = true;
    try {
      const engine = (await this.store.read()).engines.find((item) => item.id === id);
      if (id !== "local-layout" && (!engine || engine.kind !== "local")) throw new ApiError(404, "ocr_not_found", "Local OCR model not found.");
      if (this.stopped || (automatic && this.automaticCancelled)) return;
      if ((id === "local-fast" || id === "local-layout") && !automatic) {
        await rm(join(this.runtime.root, "auto-download-cancelled"), { force: true });
        this.automaticCancelled = false;
      }
      if (!this.stopped && !(automatic && this.automaticCancelled)) {
        if (id === "local-layout") await this.runtime.installLayout();
        else if (engine?.kind === "local") await this.runtime.install(engine);
      }
    } finally { this.startingInstall = false; }
  }
  async test(id: string) {
    if (this.runtime.busy || this.testing || this.startingInstall) throw new ApiError(409, "ocr_busy", "Wait for the current OCR operation to finish.");
    this.testing = true;
    try {
      const service = await this.service();
      const engine = service.listEngines().find((item) => item.id === id);
      if (!engine) throw new ApiError(404, "ocr_not_found", "OCR model not found.");
      const result = await service.extract({ sourceId: "ocr-settings-test", engineId: id, languages: engine.languages?.slice(0, 1) ?? ["en"], pages: [await ocrTestPage()] })
        .finally(() => service.close());
      if (!result.pages[0]?.text.trim()) throw new ApiError(502, "ocr_empty_test", "The model returned no text for the sample image.");
      return { ok: true };
    } finally { this.testing = false; }
  }
}
