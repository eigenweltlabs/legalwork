import { createErrorDiagnostic } from "@legalwork/types/error-diagnostics";
import { ErrorDiagnosticSchema, ErrorFrameSchema, type ErrorDiagnostic } from "@legalwork/types/error-report";
import { analyticsSurface, captureErrorAnalytics } from "./analytics";
import type { ModelRef, ProviderListItem } from "../types";

const MAX_INCIDENTS = 50;
const STORAGE_KEY = "legalwork.error-incidents.v1";
const LOCAL_TTL_MS = 24 * 60 * 60 * 1000;
const incidents = new Map<string, ErrorDiagnostic>();
let errorObjects = new WeakMap<object, ErrorDiagnostic>();
const listeners = new Set<() => void>();
let snapshot: ErrorDiagnostic[] = [];
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let selectedId: string | null = null;
let engineVersion: string | null = null;
let applicationAssets = new Map<string, string | null>();
type RunErrorContext = { providerId?: string; modelId?: string; baseURL?: string; api_format?: ErrorDiagnostic["api_format"] };
const runContexts = new Map<string, RunErrorContext>();

export function subscribeErrorReports(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getErrorReports(): ErrorDiagnostic[] { return snapshot; }
export function getSelectedErrorId(): string | null { return selectedId; }
export function restoreLocalErrorReports(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 150_000) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed.slice(-MAX_INCIDENTS)) {
      const result = ErrorDiagnosticSchema.safeParse(item);
      if (result.success && Date.parse(result.data.occurred_at) >= Date.now() - LOCAL_TTL_MS) remember(result.data, false);
    }
    persist();
  } catch { /* Storage can be unavailable; reporting still works in memory. */ }
}
function persist(): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* Memory remains available. */ }
}
export function clearLocalErrorReports(): void {
  void globalThis.window?.__LEGALWORK_ELECTRON__?.clearErrorRecords?.().catch(() => {});
  incidents.clear(); errorObjects = new WeakMap(); snapshot = []; selectedId = null; persist(); scheduleExpiry(); notify();
}
function notify(): void { for (const listener of listeners) listener(); }
export function openErrorReport(incidentId: string): void { selectedId = incidentId; notify(); }
export function closeErrorReport(): void { selectedId = null; notify(); }
/** Read the effective provider override, rather than the catalog's often-empty model URL. */
export function providerRunErrorContext(model: ModelRef, providers: readonly (Pick<ProviderListItem, "id" | "options"> & {
  models: Record<string, Pick<ProviderListItem["models"][string], "api">>;
})[] = []): RunErrorContext {
  const provider = providers.find(item => item.id === model.providerID);
  const api = provider?.models[model.modelID]?.api;
  const override = provider?.options.baseURL;
  const formats: Record<string, ErrorDiagnostic["api_format"]> = {
    "@ai-sdk/openai-compatible": "chat_completions",
    "@ai-sdk/anthropic": "anthropic_messages",
    "@ai-sdk/openai": "responses",
  };
  return {
    providerId: model.providerID, modelId: model.modelID,
    baseURL: typeof override === "string" && override ? override : api?.url,
    ...(api?.npm && formats[api.npm] ? { api_format: formats[api.npm] } : {}),
  };
}
export function rememberRunContext(sessionId: string, context: RunErrorContext): void {
  runContexts.delete(sessionId);
  runContexts.set(sessionId, context);
  if (runContexts.size > MAX_INCIDENTS) {
    const oldest = runContexts.keys().next().value;
    if (oldest) runContexts.delete(oldest);
  }
}
export function getRunErrorContext(sessionId: string) { return runContexts.get(sessionId); }
export function setDiagnosticEngineVersion(value: unknown): void {
  const parsed = ErrorDiagnosticSchema.shape.engine_version.safeParse(value);
  engineVersion = parsed.success ? parsed.data : null;
}
export async function initDiagnosticAssets(): Promise<void> {
  if (import.meta.env.DEV) return;
  try {
    const native = globalThis.window?.__LEGALWORK_ELECTRON__;
    const value: unknown = native?.getDiagnosticAssets
      ? await native.getDiagnosticAssets()
      : await (await fetch(`${import.meta.env.BASE_URL}diagnostics-assets.json`, { credentials: "omit" })).json();
    if (!Array.isArray(value)) return;
    const entries = value.map(item => ErrorFrameSchema.pick({ asset: true, chunk_id: true }).safeParse(item));
    if (entries.every(item => item.success)) applicationAssets = new Map(entries.flatMap(item => item.success ? [[item.data.asset, item.data.chunk_id]] : []));
  } catch { /* An unavailable manifest means omit frames, never upload paths. */ }
}

function scheduleExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  if (!incidents.size) { expiryTimer = null; return; }
  const earliest = Math.min(...Array.from(incidents.values(), item => Date.parse(item.occurred_at) + LOCAL_TTL_MS));
  expiryTimer = setTimeout(() => {
    const cutoff = Date.now() - LOCAL_TTL_MS;
    for (const [id, item] of incidents) if (Date.parse(item.occurred_at) <= cutoff) incidents.delete(id);
    snapshot = Array.from(incidents.values()); persist(); notify(); scheduleExpiry();
  }, Math.max(1, Math.min(earliest - Date.now() + 1, LOCAL_TTL_MS)));
  // Browser timers are numeric; Node/Bun test timers should not hold a process open.
  if (typeof expiryTimer === "object") expiryTimer.unref();
}
function remember(diagnostic: ErrorDiagnostic, automatic = true): ErrorDiagnostic {
  if (incidents.has(diagnostic.incident_id)) return diagnostic;
  const cutoff = Date.now() - LOCAL_TTL_MS;
  for (const [id, item] of incidents) if (Date.parse(item.occurred_at) < cutoff) incidents.delete(id);
  incidents.set(diagnostic.incident_id, diagnostic);
  if (incidents.size > MAX_INCIDENTS) {
    const oldest = incidents.keys().next().value;
    if (oldest) incidents.delete(oldest);
  }
  snapshot = Array.from(incidents.values());
  persist(); scheduleExpiry();
  if (automatic) captureErrorAnalytics(diagnostic);
  notify();
  return diagnostic;
}

/** Always creates a local safe record. Analytics consent only controls its sink. */
export function recordError(error: unknown, context: Parameters<typeof createErrorDiagnostic>[1] = {}, options: { automatic?: boolean } = {}): ErrorDiagnostic | null {
  try {
    const version = ErrorDiagnosticSchema.shape.app_version.safeParse(import.meta.env.VITE_LEGALWORK_APP_VERSION);
    const build = ErrorDiagnosticSchema.shape.build_id.safeParse(import.meta.env.VITE_LEGALWORK_BUILD_ID);
    if (error && typeof error === "object") {
      const existing = errorObjects.get(error);
      if (existing && incidents.has(existing.incident_id)) return existing;
      // Server diagnostics were constructed before generic response formatting.
      const relayed = ErrorDiagnosticSchema.safeParse("diagnostic" in error ? error.diagnostic : undefined);
      if (relayed.success) {
        const diagnostic = { ...relayed.data, app_version: version.success ? version.data : null, build_id: build.success ? build.data : null, surface: analyticsSurface() };
        errorObjects.set(error, diagnostic);
        return remember(diagnostic, options.automatic !== false);
      }
    }
    const platform = /Mac/i.test(globalThis.navigator?.platform ?? "") ? "darwin" : /Win/i.test(globalThis.navigator?.platform ?? "") ? "win32" : /Linux/i.test(globalThis.navigator?.platform ?? "") ? "linux" : "web";
    const diagnostic = createErrorDiagnostic(error, {
      app_version: version.success ? version.data : null,
      build_id: build.success ? build.data : null,
      engine_version: engineVersion,
      platform, surface: analyticsSurface(), applicationAssets, ...context,
    });
    if (error && typeof error === "object") errorObjects.set(error, diagnostic);
    return remember(diagnostic, options.automatic !== false);
  } catch { return null; } // Reporting must never become the failure.
}

export function adoptErrorDiagnostic(value: unknown, automatic = true): ErrorDiagnostic | null {
  const parsed = ErrorDiagnosticSchema.safeParse(value);
  return parsed.success ? remember(parsed.data, automatic) : null;
}
export function diagnosticAnalyticsFields(diagnostic: ErrorDiagnostic) {
  return {
    error_id: diagnostic.incident_id, error_schema_version: diagnostic.schema_version,
    error_code: diagnostic.code, error_name: diagnostic.error_class,
    error_fingerprint: diagnostic.fingerprint, native_error_code: diagnostic.native_code,
    error_operation: diagnostic.operation, error_phase: diagnostic.phase,
    error_component: diagnostic.component, provider_id: diagnostic.provider,
    model_family: diagnostic.model_family, api_format: diagnostic.api_format,
    engine_version: diagnostic.engine_version, server_version: diagnostic.server_version, build_id: diagnostic.build_id,
    status_code: diagnostic.status_code, retryable: diagnostic.retryable,
    retry_count: diagnostic.retry_count,
  };
}
