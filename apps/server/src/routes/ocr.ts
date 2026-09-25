import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { OcrManager } from "../ocr/manager.js";
import { OcrError } from "../ocr/types.js";
import { addRoute, type Route, type RequestContext } from "./registry.js";

export function registerOcrRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  ocr: OcrManager;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
}) {
  const { routes, config, ocr, jsonResponse, readJsonBodyLimited, ensureWritable } = options;
  const route = (method: string, path: string, handler: (ctx: RequestContext) => Promise<unknown>) => {
    addRoute(routes, method, path, "host", async (ctx) => {
      if (method !== "GET") ensureWritable(config);
      try { return jsonResponse(await handler(ctx)); }
      catch (error) {
        if (error instanceof OcrError) throw new ApiError(400, error.code, error.message);
        throw error;
      }
    });
  };
  const body = (ctx: RequestContext) => readJsonBodyLimited(ctx.request, 32 * 1024);
  route("GET", "/ocr/settings", () => ocr.view(config.readOnly));
  route("PUT", "/ocr/default", async (ctx) => {
    const input = await body(ctx);
    if (typeof input.engineId !== "string") throw new ApiError(400, "ocr_invalid_settings", "Choose an OCR model.");
    await ocr.setDefault(input.engineId); return ocr.view(config.readOnly);
  });
  route("POST", "/ocr/servers", async (ctx) => { await ocr.saveServer(await body(ctx)); return ocr.view(config.readOnly); });
  route("PUT", "/ocr/servers/:id", async (ctx) => { await ocr.saveServer(await body(ctx), ctx.params.id); return ocr.view(config.readOnly); });
  route("DELETE", "/ocr/servers/:id", async (ctx) => { await ocr.removeServer(ctx.params.id); return ocr.view(config.readOnly); });
  route("POST", "/ocr/engines/:id/install", async (ctx) => { await ocr.install(ctx.params.id); return ocr.view(config.readOnly); });
  route("DELETE", "/ocr/install", async () => { ocr.runtime.cancel(); return ocr.view(config.readOnly); });
  route("POST", "/ocr/engines/:id/test", (ctx) => ocr.test(ctx.params.id));
}
