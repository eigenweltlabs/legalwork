import { z } from "zod";
import { ApiError } from "../errors.js";
import { addRoute, type Route, type RequestContext } from "./registry.js";
import type { ServerConfig, TokenScope } from "../types.js";
import {
  SystemOneProviderInputSchema,
  SystemOneRequestSchema,
  SystemOneSelectionSchema,
} from "../systemone-schema.js";
import {
  readSystemOneSettings,
  saveSystemOneProvider,
  deleteSystemOneProvider,
  saveSystemOneMemberKey,
  selectSystemOneProvider,
  systemOne,
  testSystemOneProvider,
} from "../systemone.js";

export function registerSystemOneRoutes(deps: {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (value: unknown) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  onSettingsChanged?: () => Promise<void>;
}) {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
  } = deps;
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success)
      throw new ApiError(
        400,
        "systemone_invalid_request",
        "Invalid SystemOne request.",
      );
    return result.data;
  };
  addRoute(routes, "GET", "/systemone/settings", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    return jsonResponse(await readSystemOneSettings(config));
  });
  addRoute(routes, "PUT", "/systemone/providers", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    await saveSystemOneProvider(
      config,
      parse(SystemOneProviderInputSchema, await readJsonBody(ctx.request)),
    );
    await deps.onSettingsChanged?.();
    return jsonResponse({ ok: true });
  });
  addRoute(
    routes,
    "DELETE",
    "/systemone/providers/:providerId",
    "client",
    async (ctx) => {
      ensureWritable(config);
      requireClientScope(ctx, "collaborator");
      await deleteSystemOneProvider(config, ctx.params.providerId);
      await deps.onSettingsChanged?.();
      return jsonResponse({ ok: true });
    },
  );
  addRoute(routes, "PUT", "/systemone/firm-providers/:providerId/key", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(1).max(16_384).nullable() }), await readJsonBody(ctx.request));
    await saveSystemOneMemberKey(config, ctx.params.providerId, apiKey);
    await deps.onSettingsChanged?.();
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "PUT", "/systemone/selection", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    await selectSystemOneProvider(
      config,
      parse(SystemOneSelectionSchema, await readJsonBody(ctx.request)),
    );
    await deps.onSettingsChanged?.();
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/systemone/test", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    return jsonResponse(
      await testSystemOneProvider(
        config,
        parse(SystemOneSelectionSchema, await readJsonBody(ctx.request)),
        ctx.request.signal,
      ),
    );
  });
  addRoute(routes, "POST", "/systemone", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const input = parse(
      z.object({
        request: SystemOneRequestSchema,
        providerId: z.string().min(1).optional(),
      }),
      await readJsonBody(ctx.request),
    );
    return jsonResponse(
      await systemOne(config, input.request, {
        providerId: input.providerId,
        signal: ctx.request.signal,
      }),
    );
  });
}
