import { z } from "zod";

// Wire contract, mirrored in model-api/packages/shared/src/error-report.ts.
// No open-ended technical strings: provider messages can echo customer input.
export const ErrorCodeSchema = z.enum([
  "unknown", "invalid_request", "invalid_tool_schema", "invalid_tool_name",
  "tool_arguments_invalid", "authentication", "permission_denied", "not_found",
  "model_unavailable", "context_overflow", "output_limit", "payload_too_large",
  "rate_limit", "budget_limit", "timeout", "network", "tls", "provider_overloaded",
  "internal_error", "engine_crash", "renderer_crash", "application_error", "cancelled",
]);
export const ErrorClassSchema = z.enum([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError",
  "URIError", "AggregateError", "DOMException", "AbortError", "NotFoundError",
  "NetworkError", "TimeoutError", "LegalworkServerError", "ApiError", "APIError",
  "UnknownError", "ProviderAuthError", "ProviderModelNotFoundError", "ContextOverflowError",
  "MessageOutputLengthError", "StructuredOutputError", "MessageAbortedError", "other",
]);
export const ErrorOperationSchema = z.enum([
  "unknown", "run", "send_message", "server_request", "connect_provider",
  "create_workspace", "sign_in", "startup", "render", "uncaught", "update",
  "file_read", "file_write", "file_upload", "file_download", "tool_execution",
  "ocr", "calendar", "schedule",
]);
export const ErrorSourceSchema = z.enum([
  "uncaught", "unhandledrejection", "react_render", "workspace_create",
  "integration_connect", "main_uncaught", "main_unhandledrejection", "sidecar_exit",
  "renderer_exit", "session_error", "task_send", "server_request", "startup", "handled",
]);
export const ProviderFamilySchema = z.enum([
  "anthropic", "openai", "openrouter", "fireworks", "google", "deepseek",
  "mistral", "eigenwelt", "custom", "unknown",
]);
export const ModelFamilySchema = z.enum([
  "claude_opus", "claude_sonnet", "claude_haiku", "nemotron", "gpt",
  "gemini", "deepseek", "mistral", "other", "unknown",
]);
export const NativeErrorCodeSchema = z.enum([
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "request_too_large", "rate_limit_error", "api_error", "overloaded_error",
  "invalid_request", "invalid_prompt", "context_length_exceeded", "rate_limit_exceeded",
  "authentication", "provider_overloaded", "provider_unavailable", "content_policy_violation",
  "refusal", "timeout", "server", "unmapped", "model_not_found", "internal_error",
  "request_failed", "subscription_required", "invalid_state", "oauth_exchange_failed",
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EACCES", "EPERM", "ENOENT",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const VersionSchema = z.string().max(80).regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/i).nullable();
export const ErrorFrameSchema = z.object({
  // Only hashed renderer assets or known Electron modules; no function names or paths.
  chunk_id: z.uuid().nullable(),
  asset: z.string().max(150).regex(/^(?:[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js|(?:main|runtime|updater|workspace-store|browser-panel|safe-open|error-incidents)\.mjs)$/),
  line: z.number().int().min(1).max(10_000_000),
  column: z.number().int().min(0).max(10_000_000),
}).strict();
export const ErrorDiagnosticSchema = z.object({
  schema_version: z.literal(1),
  incident_id: z.uuid(),
  occurred_at: z.iso.datetime(),
  code: ErrorCodeSchema,
  error_class: ErrorClassSchema,
  native_code: NativeErrorCodeSchema.nullable(),
  component: z.enum(["renderer", "server", "engine", "desktop", "network", "connector"]),
  source: ErrorSourceSchema,
  operation: ErrorOperationSchema,
  phase: z.enum(["unknown", "startup", "request", "stream", "tool", "render"]),
  status_code: z.number().int().min(100).max(599).nullable(),
  provider: ProviderFamilySchema,
  model_family: ModelFamilySchema,
  api_format: z.enum(["unknown", "chat_completions", "responses", "anthropic_messages"]),
  app_version: VersionSchema,
  engine_version: VersionSchema,
  server_version: VersionSchema,
  build_id: z.string().regex(/^[a-f0-9]{7,40}$/).nullable(),
  platform: z.enum(["darwin", "win32", "linux", "web", "unknown"]),
  surface: z.enum(["desktop", "office", "word", "excel", "powerpoint", "web", "server"]),
  retryable: z.boolean().nullable(),
  retry_count: z.number().int().min(0).max(100).nullable(),
  duration_ms: z.number().int().min(0).max(604_800_000).nullable(),
  exit_code: z.number().int().min(-1).max(65535).nullable(),
  causes: z.array(ErrorClassSchema).max(4),
  frames: z.array(ErrorFrameSchema).max(8),
  fingerprint: z.string().regex(/^[a-z0-9]{1,16}$/),
}).strict();
export type ErrorDiagnostic = z.infer<typeof ErrorDiagnosticSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorOperation = z.infer<typeof ErrorOperationSchema>;

// These are deliberately user-entered, optional support fields, never analytics.
export const ErrorReportSchema = z.object({
  report_id: z.uuid(),
  consent: z.literal("manual"),
  diagnostic: ErrorDiagnosticSchema,
  comment: z.string().max(2000),
}).strict();
export const ErrorReportReceiptSchema = z.object({
  report_id: z.uuid(),
  received_at: z.iso.datetime(),
}).strict();
export type ErrorReport = z.infer<typeof ErrorReportSchema>;

/** Construct exceptions explicitly; never pass an Error to an SDK's serializer. */
export function errorExceptionProperties(value: ErrorDiagnostic) {
  const error = ErrorDiagnosticSchema.parse(value);
  return {
    error_id: error.incident_id, error_schema_version: error.schema_version,
    error_code: error.code, error_operation: error.operation, error_phase: error.phase,
    error_component: error.component, error_source: error.source,
    status_code: error.status_code, native_error_code: error.native_code,
    provider_id: error.provider, model_family: error.model_family, api_format: error.api_format,
    app_version: error.app_version, engine_version: error.engine_version, server_version: error.server_version, build_id: error.build_id,
    platform: error.platform, surface: error.surface,
    retryable: error.retryable, retry_count: error.retry_count,
    duration_ms: error.duration_ms, exit_code: error.exit_code,
    $exception_fingerprint: `legalwork-v1:${error.fingerprint}`,
    $exception_level: "error",
    $issue_name: `${error.component}: ${error.code}`,
    $exception_list: [{
      type: error.error_class, value: error.code,
      mechanism: { type: "generic", source: error.source, handled: !["uncaught", "unhandledrejection", "react_render", "main_uncaught"].includes(error.source), synthetic: true },
      ...(error.frames.length ? { stacktrace: {
        type: "raw", frames: error.frames.map(frame => ({
          platform: frame.asset.endsWith(".mjs") ? "node:javascript" : "web:javascript",
          chunk_id: frame.chunk_id ?? undefined, filename: `${frame.asset.endsWith(".mjs") ? "electron" : "assets"}/${frame.asset}`,
          lineno: frame.line, colno: frame.column, in_app: true,
        })).reverse(),
      } } : {}),
    }],
    $process_person_profile: false,
    $geoip_disable: true,
  };
}
