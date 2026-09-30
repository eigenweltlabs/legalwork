import { createLocalOcrEngine } from "./local.js";
import type { LocalOcrRuntime } from "./local.js";
import { createServerOcrEngine } from "./server-engine.js";
import type { OcrFetch, OcrSecretResolver } from "./server-engine.js";
import { OcrService } from "./service.js";
import { settingsSchema } from "./settings.js";
import type { OcrSettings } from "./settings.js";

export * from "./types.js";
export * from "./settings.js";
export * from "./service.js";
export * from "./local.js";
export * from "./server-engine.js";

export function createConfiguredOcrService(input: OcrSettings, dependencies: {
  localRuntime: LocalOcrRuntime;
  resolveApiKey: OcrSecretResolver;
  fetch?: OcrFetch;
}): OcrService {
  const settings = settingsSchema.parse(input);
  const engines = settings.engines.map((engine) => engine.kind === "local"
    ? createLocalOcrEngine(engine, dependencies.localRuntime)
    : createServerOcrEngine(engine, dependencies.resolveApiKey, dependencies.fetch));
  return new OcrService(engines, settings.defaultEngineId, settings.pageTimeoutMs);
}
