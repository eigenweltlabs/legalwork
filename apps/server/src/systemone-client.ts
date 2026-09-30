import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError } from "./errors.js";
import { retryAfterMs } from "./retry-after.js";
import {
  SystemOneRequestSchema,
  SystemOneQuestionTypeSchema,
  validateSystemOneResponse,
  type SystemOneRequest,
} from "./systemone-schema.js";

const SystemOneCatalogSchema = z.object({
  models: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string(),
    release_date: z.string(),
  })).max(1000).refine((models) => new Set(models.map((m) => m.name)).size === models.length),
});

export type SystemOneTarget = {
  endpoint: string;
  apiKey: string;
  model: string;
  questionTypes: string[];
  deploymentRevision?: string;
};
/** Small protocol adapter; no chat SDK, document preparation or provider fallback. */
export async function callSystemOne(
  target: SystemOneTarget,
  input: SystemOneRequest,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    retryDelayMs?: number;
    retry?: boolean;
  } = {},
) {
  const parsed = SystemOneRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      "systemone_invalid_request",
      "Invalid SystemOne state or questions.",
    );
  const request = { ...parsed.data, model: target.model };
  if (
    Object.values(request.questions).some(
      (q) => !target.questionTypes.includes(q.type),
    )
  )
    throw new ApiError(
      422,
      "systemone_unsupported_capability",
      "The selected model does not support one of these question types.",
    );
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(120_000),
  ]);
  const fetcher = options.fetch ?? fetch;
  const attempts = options.retry === false ? 1 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await fetcher(target.endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch {
      if (options.signal?.aborted)
        throw new ApiError(
          499,
          "systemone_cancelled",
          "SystemOne request cancelled.",
        );
      if (signal.aborted)
        throw new ApiError(
          504,
          "systemone_timeout",
          "SystemOne request timed out.",
        );
      throw new ApiError(
        503,
        "systemone_unavailable",
        "Cannot reach the selected SystemOne provider.",
      );
    }
    if (response.ok) {
      try {
        const result = validateSystemOneResponse(
          request,
          await response.json(),
        );
        return {
          ...result,
          ...(target.deploymentRevision && !result.deployment_revision
            ? { deployment_revision: target.deploymentRevision }
            : {}),
        };
      } catch {
        if (options.signal?.aborted)
          throw new ApiError(
            499,
            "systemone_cancelled",
            "SystemOne request cancelled.",
          );
        if (signal.aborted)
          throw new ApiError(
            504,
            "systemone_timeout",
            "SystemOne request timed out.",
          );
        throw new ApiError(
          502,
          "systemone_invalid_response",
          "The SystemOne provider returned an invalid response.",
        );
      }
    }
    // Never return upstream bodies: they may echo state, credentials or internal URLs.
    await response.body?.cancel();
    if ([429, 529, 502, 503, 504].includes(response.status) && attempt < attempts - 1) {
      const header = response.headers.get("retry-after");
      const seconds = header === null ? NaN : Number(header);
      const retryAt =
        header && !Number.isFinite(seconds) ? Date.parse(header) : NaN;
      const ms = Number.isFinite(seconds)
        ? seconds * 1000
        : Number.isFinite(retryAt)
          ? retryAt - Date.now()
          : (options.retryDelayMs ?? 500) * 2 ** attempt;
      // Honor long Retry-After without keeping a desktop call blocked past its deadline.
      if (ms <= 30_000) {
        try {
          await delay(Math.max(0, ms), undefined, { signal });
        } catch {
          throw new ApiError(
            options.signal?.aborted ? 499 : 504,
            options.signal?.aborted
              ? "systemone_cancelled"
              : "systemone_timeout",
            "SystemOne request interrupted.",
          );
        }
        continue;
      }
    }
    if (response.status === 401)
      throw new ApiError(
        401,
        "systemone_authentication",
        "The SystemOne credential was rejected. Reconnect this provider.",
      );
    if (response.status === 403)
      throw new ApiError(
        403,
        "systemone_access_denied",
        "SystemOne access is disabled or the subscription limit has been reached.",
      );
    if ([400, 404, 422].includes(response.status))
      throw new ApiError(
        422,
        "systemone_request_rejected",
        "The provider rejected the model, question format or input size.",
      );
    if (response.status === 429)
      throw new ApiError(
        429,
        "systemone_rate_limited",
        "The SystemOne provider is rate limited. Try again later.",
        { retryAfterMs: retryAfterMs(response.headers.get("retry-after")) },
      );
    throw new ApiError(
      503,
      "systemone_unavailable",
      "The selected SystemOne provider is unavailable. Try again later.",
      { retryAfterMs: retryAfterMs(response.headers.get("retry-after")) },
    );
  }
  throw new ApiError(503, "systemone_unavailable", "SystemOne request failed.");
}

/** TypeSafe's catalog uses {models: [{name, description, release_date}]}, not OpenAI's data[]. */
export async function listSystemOneModels(
  target: { endpoint: string; apiKey: string },
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
) {
  const endpoint = new URL(target.endpoint);
  if (!/\/systemone\/?$/.test(endpoint.pathname))
    throw new ApiError(422, "systemone_catalog_unsupported", "This endpoint has no standard model catalog. Add model IDs to the provider.");
  endpoint.pathname = endpoint.pathname.replace(/\/systemone\/?$/, "/models");
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
      redirect: "error",
      signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(10_000)]),
    });
  } catch {
    throw new ApiError(503, "systemone_catalog_unavailable", "Could not load this provider's models. Check the connection or add model IDs explicitly.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(response.status === 401 || response.status === 403 ? response.status : 502,
      "systemone_catalog_unavailable", `Could not load this provider's models (HTTP ${response.status}).`);
  }
  const parsed = SystemOneCatalogSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    throw new ApiError(502, "systemone_catalog_invalid", "The provider returned an invalid SystemOne model catalog.");
  return parsed.data.models.map((model) => ({
    id: model.name, name: model.name, description: model.description, releaseDate: model.release_date,
    questionTypes: [...SystemOneQuestionTypeSchema.options],
  }));
}
