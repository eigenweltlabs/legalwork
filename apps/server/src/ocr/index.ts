import { createLocalOcrEngine } from "./local.js";
import type { LocalOcrRuntime } from "./local.js";
import { createServerOcrEngine } from "./server-engine.js";
import type { OcrFetch, OcrSecretResolver } from "./server-engine.js";
import { OcrError, type OcrContent, type OcrPage, type OcrContext } from "./types.js";
import { OcrService } from "./service.js";
import { settingsSchema } from "./settings.js";
import type { OcrSettings } from "./settings.js";

export * from "./types.js";
export * from "./settings.js";
export * from "./service.js";
export * from "./local.js";
export * from "./server-engine.js";

export type CloudOcrRuntime = {
  status: (model: string) => Promise<"ready" | "disabled" | "unavailable" | "disconnected">;
  recognize: (model: string, page: OcrPage, context: OcrContext) => Promise<OcrContent>;
};

export function createConfiguredOcrService(input: OcrSettings, dependencies: {
  localRuntime: LocalOcrRuntime;
  resolveApiKey: OcrSecretResolver;
  fetch?: OcrFetch;
  cloudRuntime?: CloudOcrRuntime;
}): OcrService {
  const settings = settingsSchema.parse(input);
  const engines: import("./types.js").OcrEngine[] = settings.engines.map((engine) => engine.kind === "local"
    ? createLocalOcrEngine(engine, dependencies.localRuntime)
    : engine.kind === "cloud-ocr" ? {
      info: { id: engine.id, label: engine.label, model: engine.model, execution: "remote",
        regions: true, languages: null, warnings: [], concurrentPages: 8 },
      recognize: (page: OcrPage, context: OcrContext) => {
        if (!dependencies.cloudRuntime) throw new OcrError("server-failed", "Cloud OCR is currently unavailable.");
        return dependencies.cloudRuntime.recognize(engine.model, page, context);
      },
    } : createServerOcrEngine(engine, dependencies.resolveApiKey, dependencies.fetch));
  return new OcrService(engines, settings.defaultEngineId, settings.pageTimeoutMs);
}
