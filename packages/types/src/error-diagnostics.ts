import {
  ErrorClassSchema, ErrorDiagnosticSchema, ErrorFrameSchema, ModelFamilySchema,
  NativeErrorCodeSchema, ProviderFamilySchema,
  type ErrorDiagnostic, type ErrorCode,
} from "./error-report.js";

type ErrorContext = Partial<Pick<ErrorDiagnostic,
  "component" | "source" | "operation" | "phase" | "surface" | "app_version" |
  "engine_version" | "server_version" | "build_id" | "platform" | "duration_ms" | "exit_code" | "status_code" | "code" | "api_format"
>> & { providerId?: unknown; modelId?: unknown; baseURL?: unknown; applicationAssets?: ReadonlyMap<string, string | null> };

function field(value: unknown, key: string): unknown {
  return value && (typeof value === "object" || typeof value === "function") && key in value ? Reflect.get(value, key) : undefined;
}
function errorRecords(error: unknown): unknown[] {
  const records: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && records.length < 8 && !seen.has(current)) {
    seen.add(current);
    records.push(current);
    const data = field(current, "data");
    if (data) records.push(data);
    const message = field(current, "message");
    if (typeof message === "string" && message.length <= 64_000 && message.trimStart().startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(message);
        records.push(parsed);
        const parsedData = field(parsed, "data");
        if (parsedData) records.push(parsedData);
      } catch { /* A plain message is only inspected for known signatures. */ }
    }
    const body = field(data, "responseBody") ?? field(current, "responseBody");
    if (typeof body === "string" && body.length <= 64_000) {
      try {
        const parsed: unknown = JSON.parse(body);
        records.push(field(parsed, "error") ?? parsed);
        const metadata = field(field(parsed, "error"), "metadata");
        if (metadata) records.push(metadata);
        const upstream = field(metadata, "raw");
        if (typeof upstream === "string" && upstream.length <= 64_000) {
          try {
            const parsedUpstream: unknown = JSON.parse(upstream);
            records.push(field(parsedUpstream, "error") ?? parsedUpstream);
          } catch { /* Only inspect structured upstream error messages. */ }
        }
      } catch { /* Provider responses need not be JSON. */ }
    }
    current = field(current, "cause");
  }
  return records.slice(0, 12);
}
function firstNumber(records: unknown[], keys: string[]): number | null {
  for (const record of records) for (const key of keys) {
    const value = field(record, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
function firstBoolean(records: unknown[], keys: string[]): boolean | null {
  for (const record of records) for (const key of keys) {
    const value = field(record, key);
    if (typeof value === "boolean") return value;
  }
  return null;
}
function className(value: unknown): ErrorDiagnostic["error_class"] {
  const name = field(value, "name");
  const constructor = ErrorClassSchema.safeParse(field(field(value, "constructor"), "name"));
  const parsed = ErrorClassSchema.safeParse(name === "Error" && constructor.success ? constructor.data : name);
  return parsed.success ? parsed.data : "other";
}
function causeClasses(error: unknown): ErrorDiagnostic["causes"] {
  const names: ErrorDiagnostic["causes"] = [];
  const seen = new Set<unknown>([error]);
  let cause = field(error, "cause");
  while (cause && names.length < 4 && !seen.has(cause)) {
    seen.add(cause);
    const name = className(cause);
    if (name !== "other") names.push(name);
    cause = field(cause, "cause");
  }
  return names;
}
function nativeCode(records: unknown[]): ErrorDiagnostic["native_code"] {
  for (const record of records) for (const key of ["error_type", "code", "type"]) {
    const parsed = NativeErrorCodeSchema.safeParse(field(record, key));
    if (parsed.success) return parsed.data;
  }
  return null;
}
function classify(records: unknown[], name: ErrorDiagnostic["error_class"], native: ErrorDiagnostic["native_code"], status: number | null): ErrorCode {
  // Inspect locally, emit constants only. Never infer schema failure from 400 alone.
  const text = records.flatMap(record => ["message"].map(key => {
    const value = field(record, key);
    return typeof value === "string" ? value.slice(0, 64_000) : "";
  })).join("\n");
  if (name === "AbortError" || name === "MessageAbortedError") return "cancelled";
  if (/tools?.*(?:input_schema|parameters).*(?:anyOf|oneOf|allOf)|invalid json schema.*tools|input_schema.*(?:must|should).*(?:object|schema)/i.test(text)) return "invalid_tool_schema";
  if (/(?:tool|function).{0,100}name.{0,100}(?:too long|maximum|max length|length.*(?:96|128)|must match)/i.test(text)) return "invalid_tool_name";
  if (name === "StructuredOutputError") return "tool_arguments_invalid";
  if (name === "ContextOverflowError" || native === "context_length_exceeded") return "context_overflow";
  if (name === "MessageOutputLengthError") return "output_limit";
  if (name === "ProviderAuthError" || status === 401 || native === "authentication" || native === "authentication_error") return "authentication";
  if (/budget.*exceeded|quota.*exceeded|daily.*limit.*reached/i.test(text)) return "budget_limit";
  if (status === 413 || native === "request_too_large") return "payload_too_large";
  if (status === 429 || native === "rate_limit_exceeded" || native === "rate_limit_error") return "rate_limit";
  if (native === "EACCES" || native === "EPERM" || status === 403) return "permission_denied";
  if (name === "ProviderModelNotFoundError" || native === "model_not_found" || native === "provider_unavailable") return "model_unavailable";
  if (native === "ENOENT" || status === 404 || native === "not_found_error") return "not_found";
  if (name === "TimeoutError" || native === "timeout" || native === "ETIMEDOUT" || status === 408 || status === 504 || (status === null || status >= 500) && /timed out/i.test(text)) return "timeout";
  if (native === "CERT_HAS_EXPIRED" || native === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || native === "DEPTH_ZERO_SELF_SIGNED_CERT") return "tls";
  if (native === "ECONNREFUSED" || native === "ECONNRESET" || native === "ENOTFOUND" || /failed to fetch|networkerror|connection (?:lost|refused)/i.test(text)) return "network";
  if (native === "overloaded_error" || native === "provider_overloaded" || status === 529) return "provider_overloaded";
  if (status !== null && status >= 500 || native === "internal_error" || native === "api_error" || native === "server") return "internal_error";
  if (status === 400 || native === "invalid_request" || native === "invalid_request_error" || native === "invalid_prompt") return "invalid_request";
  return name !== "other" && name !== "APIError" && name !== "UnknownError" ? "application_error" : "unknown";
}
function providerFamily(context: ErrorContext): ErrorDiagnostic["provider"] {
  const parsed = ProviderFamilySchema.safeParse(context.providerId);
  if (parsed.success && parsed.data !== "unknown" && parsed.data !== "custom") return parsed.data;
  if (typeof context.baseURL === "string") {
    try {
      const host = new URL(context.baseURL).hostname;
      const hosts: Record<string, ErrorDiagnostic["provider"]> = {
        "openrouter.ai": "openrouter", "api.anthropic.com": "anthropic",
        "api.openai.com": "openai", "api.fireworks.ai": "fireworks",
        "api.deepseek.com": "deepseek", "api.mistral.ai": "mistral",
      };
      if (hosts[host]) return hosts[host];
    } catch { /* Invalid/private endpoints are just custom. */ }
  }
  return typeof context.providerId === "string" && context.providerId ? "custom" : "unknown";
}
function modelFamily(value: unknown): ErrorDiagnostic["model_family"] {
  if (typeof value !== "string" || !value) return "unknown";
  const families: Array<[RegExp, ErrorDiagnostic["model_family"]]> = [
    [/claude[/-]opus/i, "claude_opus"], [/claude[/-]sonnet/i, "claude_sonnet"],
    [/claude[/-]haiku/i, "claude_haiku"], [/nemo[tr]ron|nemotron/i, "nemotron"],
    [/(?:^|\/)gpt-/i, "gpt"], [/gemini/i, "gemini"], [/deepseek/i, "deepseek"], [/mistral/i, "mistral"],
  ];
  return families.find(([pattern]) => pattern.test(value))?.[1] ?? "other";
}
function frames(error: unknown, assets?: ReadonlyMap<string, string | null>): ErrorDiagnostic["frames"] {
  const stack = field(error, "stack");
  if (typeof stack !== "string") return [];
  return stack.split("\n").slice(1, 40).flatMap(line => {
    // Accept only app-owned hashed assets. Discard source URLs, paths, functions.
    const match = line.match(/(?:^|[/\\])assets\/([A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js):(\d+):(\d+)\)?$/);
    if (!match || !assets?.has(match[1])) return [];
    const parsed = ErrorFrameSchema.safeParse({ asset: match[1], chunk_id: assets.get(match[1]) ?? null, line: Number(match[2]), column: Number(match[3]) });
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 8);
}
function fingerprint(parts: unknown[]): string {
  // Only normalized technical fields enter this hash, never raw errors or names.
  const text = JSON.stringify(parts);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
export function createErrorDiagnostic(error: unknown, context: ErrorContext = {}): ErrorDiagnostic {
  const records = errorRecords(error);
  const classes = records.map(className);
  const name = classes.find(name => name !== "Error" && name !== "other") ?? className(error);
  const statusValue = firstNumber([...records, ...records.map(record => field(record, "response"))], ["statusCode", "status"]);
  const status = (statusValue !== null && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : context.status_code ?? null);
  const native = nativeCode(records);
  const provider = providerFamily(context);
  const model = ModelFamilySchema.parse(modelFamily(context.modelId));
  const code = context.code ?? (context.source === "sidecar_exit" ? "engine_crash" : context.source === "react_render" || context.source === "renderer_exit" ? "renderer_crash" : classify(records, name, native, status));
  const appFrames = frames(error, context.applicationAssets);
  const operation = context.operation ?? "unknown";
  const retryCount = firstNumber(records, ["retryCount", "retries"]);
  const format = context.api_format ?? (provider === "anthropic" ? "anthropic_messages" : provider === "openrouter" || provider === "fireworks" ? "chat_completions" : "unknown");
  const value = {
    schema_version: 1, incident_id: crypto.randomUUID(), occurred_at: new Date().toISOString(),
    code, error_class: name, native_code: native, component: context.component ?? "renderer",
    source: context.source ?? "handled", operation, phase: context.phase ?? "unknown",
    status_code: status, provider, model_family: model, api_format: format,
    app_version: ErrorDiagnosticSchema.shape.app_version.safeParse(context.app_version ?? null).data ?? null,
    engine_version: ErrorDiagnosticSchema.shape.engine_version.safeParse(context.engine_version ?? null).data ?? null,
    server_version: ErrorDiagnosticSchema.shape.server_version.safeParse(context.server_version ?? null).data ?? null,
    build_id: context.build_id ?? null, platform: context.platform ?? "unknown",
    surface: context.surface ?? "web", retryable: firstBoolean(records, ["isRetryable", "retryable"]),
    retry_count: retryCount !== null && Number.isInteger(retryCount) && retryCount >= 0 && retryCount <= 100 ? retryCount : null,
    duration_ms: context.duration_ms ?? null, exit_code: context.exit_code ?? null,
    causes: causeClasses(error),
    frames: appFrames,
    fingerprint: fingerprint([code, name, native, status, provider, model, operation, context.component, appFrames]),
  };
  return ErrorDiagnosticSchema.parse(value);
}
