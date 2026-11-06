import { Agent } from "@opencode/schema/agent";
import { Config } from "@opencode/schema/config";
import { Location } from "@opencode/schema/location";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import { inferNativeDefaultVariant } from "./native-shared-values.js";
import type { NativeModelDisplay } from "@legalwork/types/native-model-display";
import type { JsonValue } from "@opencode/client";
import { Schema } from "effect";
import { ApiError } from "./errors.js";
import { runtimeEngineConfiguration } from "./runtime-config-upgrade.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Generation fields have documented meaning. Arbitrary extension bags may
 * contain credentials under custom names and are never copied to clients. */
export function publicGenerationControls(input: unknown): Record<string, JsonValue> {
  const source = record(input), result: Record<string, JsonValue> = {};
  for (const name of ["temperature", "topP", "top_p", "topK", "top_k", "maxTokens", "max_tokens", "maxOutputTokens", "max_output_tokens", "presencePenalty", "presence_penalty", "frequencyPenalty", "frequency_penalty", "seed", "n", "budget", "budgetTokens", "budget_tokens", "thinkingBudget", "thinking_budget", "reasoningBudget"]) {
    if (typeof source[name] === "number" && Number.isFinite(source[name])) result[name] = source[name];
  }
  for (const name of ["parallelToolCalls", "parallel_tool_calls", "strictJsonSchema", "includeThoughts", "include_thoughts", "enabled", "logprobs"]) {
    if (typeof source[name] === "boolean") result[name] = source[name];
  }
  const enums: Record<string, string[]> = {
    reasoningEffort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], reasoning_effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], textVerbosity: ["low", "medium", "high"], verbosity: ["low", "medium", "high"],
    type: ["enabled", "disabled", "adaptive"], summary: ["auto", "concise", "detailed"], thinkingLevel: ["minimal", "low", "medium", "high"],
  };
  for (const [name, values] of Object.entries(enums)) if (typeof source[name] === "string" && values.includes(source[name])) result[name] = source[name];
  for (const name of ["reasoning", "thinking", "reasoningConfig", "generationConfig", "text"]) {
    if (source[name] && typeof source[name] === "object" && !Array.isArray(source[name])) result[name] = publicGenerationControls(source[name]);
  }
  return result;
}

function publicSettings(input: unknown) {
  const source = record(input), result = publicGenerationControls(source);
  for (const name of ["timeout", "headerTimeout", "chunkTimeout"]) {
    if (source[name] === false || typeof source[name] === "number" && Number.isFinite(source[name])) result[name] = source[name];
  }
  if (source.transport === "http" || source.transport === "websocket") result.transport = source.transport;
  if (source.encoding === "none" || source.encoding === "gzip" || source.encoding === "zstd") result.encoding = source.encoding;
  const compaction = record(source.compaction);
  if (compaction.type === "native" || compaction.type === "summary") result.compaction = { type: compaction.type };
  return Schema.decodeUnknownSync(Provider.Settings)(result);
}

export function publicNativeModel(model: typeof Model.Info.Type): typeof Model.Info.Type & NativeModelDisplay {
  const { settings, headers, body, variants, ...metadata } = model;
  return { ...metadata, settings: publicSettings(settings), body: publicGenerationControls(body),
    variants: variants.map(({ settings, headers, body, ...variant }) => ({ ...variant, settings: publicSettings(settings), body: publicGenerationControls(body) })),
    legalwork: { defaultVariantID: inferNativeDefaultVariant(model) ?? null },
  };
}

function publicProvider(provider: typeof Provider.Info.Type) {
  const { settings, headers, body, ...metadata } = provider;
  return { ...metadata, settings: publicSettings(settings), body: publicGenerationControls(body),
    legalwork: { hasCustomEndpoint: typeof settings?.baseURL === "string" && settings.baseURL.length > 0 },
  };
}

function publicAgent(agent: typeof Agent.Info.Type) {
  return { ...agent, request: { settings: publicSettings(agent.request.settings), headers: {}, body: publicGenerationControls(agent.request.body) } };
}

/** Public config documents describe safe choices. Executable definitions,
 * endpoints, plugin options, process environments and custom auth bags are
 * edited through LegalWork's authoritative settings API, never this view. */
export function publicNativeConfig(config: typeof Config.Info.Type): typeof Config.Info.Type {
  const { model, default_agent, update, share, username, permissions, policies, snapshots, media, tool_output, compaction, experimental } = config;
  return { model, default_agent, update, share, username, permissions, policies, snapshots, media, tool_output, compaction, experimental,
    agents: config.agents && Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, {
      ...agent, request: agent.request && { headers: {}, body: publicGenerationControls(agent.request.body) },
    }])),
    providers: config.providers && Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
      canonical: provider.canonical, name: provider.name, env: provider.env, package: provider.package, compatibility: provider.compatibility,
      settings: publicSettings(provider.settings), body: publicGenerationControls(provider.body),
      models: provider.models && Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, {
        modelID: model.modelID, family: model.family, name: model.name, releaseDate: model.releaseDate, compatibility: model.compatibility, package: model.package,
        capabilities: model.capabilities, cost: model.cost, disabled: model.disabled, limit: model.limit,
        settings: publicSettings(model.settings), body: publicGenerationControls(model.body),
        variants: model.variants?.map(variant => ({ id: variant.id, settings: publicSettings(variant.settings), body: publicGenerationControls(variant.body) })),
      }])),
    }])),
  };
}

export function publicNativeConfigSnapshot(input: Record<string, unknown>) {
  return { ...publicNativeConfig(runtimeEngineConfiguration(input)), $legalworkReadOnlyProjection: true };
}

/** Only the browser-facing LW proxy calls this. Native server/main/plugin
 * clients retain the original complete engine response and runtime behavior. */
export async function projectNativeClientRead(method: string, path: string, response: Response, modelAllowed?: (model: typeof Model.Info.Type) => boolean): Promise<Response> {
  if (method !== "GET" || !response.ok || !/^\/(?:(?:experimental\/)?config|provider(?:\/[^/]+)?|model(?:\/default)?|agent(?:\/[^/]+)?)$/.test(path)) return response;
  let projected: unknown;
  try {
    const payload: unknown = await response.json();
    if (path === "/config" || path === "/experimental/config") {
      projected = Schema.decodeUnknownSync(Config.Entry.pipe(Schema.Array))(payload).map(entry => entry.type === "document" ? { ...entry, info: publicNativeConfig(entry.info) } : entry);
    } else if (path === "/model") {
      const envelope = Schema.decodeUnknownSync(Location.response(Model.Info.pipe(Schema.Array)))(payload);
      projected = { ...envelope, data: envelope.data.filter(model => !modelAllowed || modelAllowed(model)).map(publicNativeModel) };
    } else if (path === "/model/default") {
      const envelope = Schema.decodeUnknownSync(Location.response(Schema.Union([Model.Info, Schema.Null])))(payload);
      projected = { ...envelope, data: envelope.data && (!modelAllowed || modelAllowed(envelope.data)) ? publicNativeModel(envelope.data) : null };
    } else if (path.startsWith("/provider")) {
      projected = path === "/provider"
        ? (() => { const envelope = Schema.decodeUnknownSync(Location.response(Provider.Info.pipe(Schema.Array)))(payload); return { ...envelope, data: envelope.data.map(publicProvider) }; })()
        : (() => { const envelope = Schema.decodeUnknownSync(Location.response(Provider.Info))(payload); return { ...envelope, data: publicProvider(envelope.data) }; })();
    } else {
      projected = path === "/agent"
        ? (() => { const envelope = Schema.decodeUnknownSync(Location.response(Agent.Info.pipe(Schema.Array)))(payload); return { ...envelope, data: envelope.data.map(publicAgent) }; })()
        : (() => { const envelope = Schema.decodeUnknownSync(Location.response(Agent.Info))(payload); return { ...envelope, data: publicAgent(envelope.data) }; })();
    }
  } catch { throw new ApiError(502, "opencode_invalid_response", "The engine returned invalid connection metadata."); }
  const headers = new Headers(response.headers);
  for (const name of ["content-encoding", "transfer-encoding", "content-length"]) headers.delete(name);
  headers.set("content-type", "application/json"); headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(projected), { status: response.status, statusText: response.statusText, headers });
}
