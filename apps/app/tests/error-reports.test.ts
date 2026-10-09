import { afterEach, beforeEach, describe, expect, test } from "bun:test";
process.env.VITE_LEGALWORK_POSTHOG_KEY = "phc_test_dummy_key";
const { recordError, getErrorReports, clearLocalErrorReports, restoreLocalErrorReports, providerRunErrorContext, rememberRunContext, getRunErrorContext, collectFullErrorDetails, setErrorDetailsLoader } = await import("../src/app/lib/error-reports");
const { makeManualErrorEvent, sendManualErrorEvent, captureAnalyticsEvent, flushAnalytics, disposeAnalytics, setAnalyticsConsentOverride, discardPendingAnalytics } = await import("../src/app/lib/analytics");
const { createLegalworkServerClient } = await import("../src/app/lib/legalwork-server");
const { createErrorDiagnostic } = await import("@legalwork/types/error-diagnostics");
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const outgoing: string[] = [];
let storage: Map<string, string>;
function consent(enabled: boolean) { storage.set("legalwork.preferences", JSON.stringify({ analyticsEnabled: enabled })); setAnalyticsConsentOverride(enabled); }
const canary = "CONFIDENTIAL_client_document_sk-123_private@example.com";

beforeEach(() => {
  disposeAnalytics(); outgoing.length = 0; storage = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } } });
  consent(false); clearLocalErrorReports();
  globalThis.fetch = async (_input, init) => { outgoing.push(String(init?.body)); return Response.json({}); };
});
afterEach(() => {
  consent(false); clearLocalErrorReports(); disposeAnalytics();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  globalThis.fetch = originalFetch;
});
const failure = () => ({ name: "APIError", data: { statusCode: 400, message: canary, responseBody: JSON.stringify({ error: { metadata: { flagged_input: canary } } }) } });

describe("manual error reporting with analytics off", () => {
  test("desktop reports retain only the selected native error and exclude broad support logs", async () => {
    const selected = recordError(new Error("SELECTED_RENDERER_ERROR"));
    const other = recordError(new Error("OTHER_RENDERER_ERROR"));
    if (!selected || !other) throw new Error("missing_diagnostic");
    const nativeError = { name: "Error", message: "SELECTED_NATIVE_ERROR", stack: "Error: SELECTED_NATIVE_ERROR\n at handle (/desktop/main.mjs:6:7)", context: { exitCode: 7 } };
    const collected: string[] = [];
    Object.defineProperty(window, "__LEGALWORK_ELECTRON__", { value: {
      collectErrorDetails: async (id: string) => {
        collected.push(id);
        // Simulate an older main process during a renderer update.
        return { error: id === selected.incident_id ? nativeError : null, support_bundle: "UNRELATED_SUPPORT_LOG_CONTENT", runtime: "UNRELATED_RUNTIME_CONTEXT" };
      },
    } });
    const details = await collectFullErrorDetails(selected);
    expect(details.attachments.desktop).toEqual({ error: nativeError });
    await sendManualErrorEvent(selected, crypto.randomUUID(), globalThis.fetch, details);
    expect(outgoing[0]).toContain("SELECTED_NATIVE_ERROR");
    expect(outgoing[0]).toContain("/desktop/main.mjs");
    for (const content of ["OTHER_RENDERER_ERROR", "UNRELATED_SUPPORT_LOG_CONTENT", "UNRELATED_RUNTIME_CONTEXT", "support_bundle"]) expect(outgoing[0]).not.toContain(content);
    const otherDetails = await collectFullErrorDetails(other);
    expect(otherDetails.attachments.desktop).toBeUndefined();
    expect(JSON.stringify(otherDetails)).toContain("OTHER_RENDERER_ERROR");
    expect(JSON.stringify(otherDetails)).not.toContain("SELECTED_NATIVE_ERROR");
    expect(JSON.stringify(otherDetails)).not.toContain("UNRELATED_SUPPORT_LOG_CONTENT");
    expect(collected).toEqual([selected.incident_id, other.incident_id]);
  });
  test("the actual API client retrieves the server's original stack only when opening a report", async () => {
    const diagnostic = createErrorDiagnostic(new TypeError("PRIVATE_SERVER_ROOT"), { source: "server_request", component: "server" });
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      paths.push(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-client-token");
      return String(input).includes("/error-reports/")
        ? Response.json({ error: { name: "TypeError", message: "PRIVATE_SERVER_ROOT", stack: "TypeError: PRIVATE_SERVER_ROOT\n at handle (/server/private.ts:6:7)" } })
        : Response.json({ code: "internal_error", message: "Unexpected server error", diagnostic }, { status: 500 });
    };
    await expect(createLegalworkServerClient({ baseUrl: "http://localhost:1234", token: "private-client-token" }).listWorkspaces()).rejects.toThrow("Unexpected server error");
    expect(paths).toEqual(["http://localhost:1234/workspaces"]);
    const stored = getErrorReports().find(item => item.incident_id === diagnostic.incident_id);
    if (!stored) throw new Error("Missing server incident");
    const full = await collectFullErrorDetails(stored);
    expect(paths).toEqual(["http://localhost:1234/workspaces", `http://localhost:1234/error-reports/${diagnostic.incident_id}`]);
    expect(JSON.stringify(full)).toContain("PRIVATE_SERVER_ROOT"); expect(JSON.stringify(full)).toContain("/server/private.ts");
    expect(JSON.stringify(full)).not.toContain("private-client-token");
  });
  test("both consent states can explicitly send full frozen reports, while automatic events and storage stay safe", async () => {
    for (const enabled of [false, true]) {
      consent(enabled);
      const original = Object.assign(new Error("PRIVATE_REPORT_CONTENT /Users/Client/private.docx", { cause: new TypeError("ROOT_CAUSE_CONTENT") }), {
        responseBody: "PRIVATE_PROVIDER_BODY", apiKey: "sk-or-v1-full-report-secret",
      });
      const diagnostic = recordError(original, { operation: enabled ? "render" : "run" });
      if (!diagnostic) throw new Error("missing_diagnostic");
      let collections = 0;
      setErrorDetailsLoader(original, async () => { collections++; return { error: { name: "TypeError", message: "SERVER_ROOT_CONTENT", stack: "TypeError: SERVER_ROOT_CONTENT\n at server (/private/server.ts:4:5)" } }; });
      expect(collections).toBe(0);
      const details = await collectFullErrorDetails(diagnostic);
      expect(collections).toBe(1);
      expect(outgoing).toEqual([]);
      original.message = "LATER_MUTATION";
      const id = crypto.randomUUID();
      const preview = makeManualErrorEvent(diagnostic, id, details);
      const bodies: string[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        expect(init?.keepalive).toBe(false);
        bodies.push(String(init?.body));
        return new Response(null, { status: bodies.length === 1 ? 503 : 200 });
      };
      await expect(sendManualErrorEvent(diagnostic, id, fetchImpl, details)).rejects.toThrow("not_sent");
      await sendManualErrorEvent(diagnostic, id, fetchImpl, details);
      expect(bodies[0]).toBe(bodies[1]);
      expect(JSON.parse(bodies[1]).batch).toEqual([preview]);
      for (const content of ["PRIVATE_REPORT_CONTENT", "PRIVATE_PROVIDER_BODY", "ROOT_CAUSE_CONTENT", "SERVER_ROOT_CONTENT", "/Users/Client/private.docx"]) expect(bodies[1]).toContain(content);
      expect(bodies[1]).not.toContain("LATER_MUTATION"); expect(bodies[1]).not.toContain("sk-or-v1-full-report-secret");
      expect(preview.properties.$exception_list[0].value).toBe("SERVER_ROOT_CONTENT");
      expect(storage.get("legalwork.error-incidents.v1")).not.toContain("PRIVATE_REPORT_CONTENT");
      await flushAnalytics();
      for (const automatic of outgoing) {
        expect(automatic).not.toContain("PRIVATE_REPORT_CONTENT"); expect(automatic).not.toContain("PRIVATE_PROVIDER_BODY");
        expect(automatic).not.toContain("error_details"); expect(automatic).not.toContain("/Users/Client");
      }
      outgoing.length = 0; clearLocalErrorReports(); disposeAnalytics();
    }
  });
  test("clearing or restoring history cannot retain raw exceptions or loaders", async () => {
    const original = new Error("PRIVATE_MEMORY_CONTENT");
    const diagnostic = recordError(original);
    if (!diagnostic) throw new Error("missing_diagnostic");
    const stored = storage.get("legalwork.error-incidents.v1") ?? "[]";
    setErrorDetailsLoader(original, async () => { throw new Error("Loader must have been cleared"); });
    clearLocalErrorReports(); storage.set("legalwork.error-incidents.v1", stored); restoreLocalErrorReports();
    const details = await collectFullErrorDetails(diagnostic);
    expect(details.error).toBeNull(); expect(details.unavailable.join(" ")).toContain("unavailable");
    expect(JSON.stringify(details)).not.toContain("PRIVATE_MEMORY_CONTENT");
  });
  test("keeps a local incident and sends exactly the preview only on explicit submission", async () => {
    const diagnostic = recordError(failure(), { operation: "run", providerId: canary, modelId: "anthropic/claude-opus-4.6" });
    if (!diagnostic) throw new Error("missing_diagnostic");
    await flushAnalytics();
    expect(outgoing).toEqual([]);
    expect(getErrorReports()).toContain(diagnostic);
    expect(storage.get("legalwork.error-incidents.v1")).not.toContain(canary);
    const eventId = crypto.randomUUID();
    const preview = makeManualErrorEvent(diagnostic, eventId);
    const sentId = await sendManualErrorEvent(diagnostic, eventId, async (url, init) => {
      expect(String(url)).toBe("https://eu.i.posthog.com/batch/");
      expect(init?.credentials).toBe("omit");
      outgoing.push(String(init?.body));
      return new Response(null, { status: 200 });
    });
    expect(sentId).toBe(eventId);
    expect(outgoing).toHaveLength(1);
    const payload = JSON.parse(outgoing[0]);
    expect(Object.keys(payload).sort()).toEqual(["api_key", "batch"]);
    expect(payload.api_key).toMatch(/^phc_/);
    expect(payload.batch).toEqual([preview]);
    expect(preview.event).toBe("$exception");
    expect(preview.properties.error_origin).toBe("manual");
    expect(preview.properties.$geoip_disable).toBe(true);
    expect(preview.properties.$process_person_profile).toBe(false);
    expect(JSON.stringify(preview)).not.toContain(canary);
    expect(preview.distinct_id).toBe(`manual-error:${eventId}`);
    expect(JSON.parse(storage.get("legalwork.preferences") ?? "{}").analyticsEnabled).toBe(false);
    captureAnalyticsEvent("task_run_started"); recordError(new TypeError(canary));
    await flushAnalytics(); expect(outgoing).toHaveLength(1);
  });
  test("custom provider errors preserve the actual route without sharing configuration", async () => {
    const model = { providerID: canary, modelID: "anthropic/claude-opus-4.6" };
    for (const [npm, format] of [["@ai-sdk/openai-compatible", "chat_completions"], ["@ai-sdk/openai", "responses"]]) {
      const context = providerRunErrorContext(model, [{
        id: canary, options: { baseURL: `https://openrouter.ai/api/v1?private=${canary}`, apiKey: canary },
        models: { [model.modelID]: { api: { id: model.modelID, url: "", npm } } },
      }]);
      rememberRunContext("private-session", context);
      const diagnostic = recordError({ name: "APIError", data: { statusCode: 401, message: canary } }, {
        ...getRunErrorContext("private-session"), component: "engine", source: "session_error", operation: "run",
      });
      if (!diagnostic) throw new Error("missing_diagnostic");
      await sendManualErrorEvent(diagnostic, crypto.randomUUID());
      const event = JSON.parse(outgoing.at(-1) ?? "{}").batch[0];
      expect(event.properties.provider_id).toBe("openrouter");
      expect(event.properties.api_format).toBe(format);
      expect(event.properties.model_family).toBe("claude_opus");
      expect(event.properties.status_code).toBe(401);
      expect(JSON.stringify(event)).not.toContain(canary);
      expect(JSON.stringify(event)).not.toContain("https://");
      expect(JSON.stringify(event)).not.toContain("private-session");
    }
    expect(outgoing).toHaveLength(2);
  });
  test("restores safe recent records without automatically uploading old incidents", async () => {
    const diagnostic = recordError(failure());
    const stored = storage.get("legalwork.error-incidents.v1");
    clearLocalErrorReports();
    storage.set("legalwork.error-incidents.v1", stored ?? "[]");
    consent(true); restoreLocalErrorReports(); await flushAnalytics();
    expect(getErrorReports()[0]?.incident_id).toBe(diagnostic?.incident_id);
    expect(outgoing).toEqual([]);
  });
  test("reports rejected delivery and preserves the event UUID and payload on retry", async () => {
    const diagnostic = recordError(failure());
    if (!diagnostic) throw new Error("missing_diagnostic");
    const eventId = crypto.randomUUID();
    await expect(sendManualErrorEvent(diagnostic, eventId, async () => new Response(null, { status: 503 }))).rejects.toThrow("not_sent");
    await expect(sendManualErrorEvent(diagnostic, eventId, async () => new Response(null, { status: 400 }))).rejects.toThrow("not_sent");
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); throw new Error("offline"); };
    await expect(sendManualErrorEvent(diagnostic, eventId, fetchImpl)).rejects.toThrow("offline");
    await expect(sendManualErrorEvent(diagnostic, eventId, fetchImpl)).rejects.toThrow("offline");
    expect(bodies[0]).toBe(bodies[1]);
  });
  test("manual consent sends no pending general analytics, even before onboarding", async () => {
    storage.delete("legalwork.preferences");
    // A pending onboarding choice holds ordinary events without sending them.
    disposeAnalytics(); captureAnalyticsEvent("pending_onboarding_event");
    const diagnostic = recordError(failure());
    if (!diagnostic) throw new Error("missing_diagnostic");
    const eventId = crypto.randomUUID();
    await sendManualErrorEvent(diagnostic, eventId);
    await flushAnalytics();
    expect(outgoing).toHaveLength(1);
    expect(JSON.parse(outgoing[0]).batch).toEqual([makeManualErrorEvent(diagnostic, eventId)]);
    expect(outgoing[0]).not.toContain("pending_onboarding_event");
    expect(storage.has("legalwork.preferences")).toBe(false);
  });
  test("manual consent also works with analytics enabled without flushing unrelated events", async () => {
    consent(true); captureAnalyticsEvent("unrelated_event");
    const diagnostic = recordError(failure());
    if (!diagnostic) throw new Error("missing_diagnostic");
    const eventId = crypto.randomUUID();
    await sendManualErrorEvent(diagnostic, eventId);
    expect(outgoing).toHaveLength(1);
    expect(JSON.parse(outgoing[0]).batch).toEqual([makeManualErrorEvent(diagnostic, eventId)]);
    expect(JSON.parse(storage.get("legalwork.preferences") ?? "{}").analyticsEnabled).toBe(true);
    await flushAnalytics();
    expect(JSON.parse(outgoing[1]).api_key).toBe(JSON.parse(outgoing[0]).api_key);
    expect(JSON.parse(outgoing[1]).batch.map((entry: { event: string }) => entry.event)).toEqual(["unrelated_event", "$exception"]);
  });
  test("manual sharing rejects untrusted diagnostic fields and invalid event IDs before sending", async () => {
    const diagnostic = recordError(failure());
    if (!diagnostic) throw new Error("missing_diagnostic");
    const untrusted = { ...diagnostic, message: canary };
    await expect(sendManualErrorEvent(untrusted, crypto.randomUUID())).rejects.toThrow();
    await expect(sendManualErrorEvent({ ...diagnostic, frames: [{ asset: "/Users/client/document.js", chunk_id: null, line: 1, column: 1 }] }, crypto.randomUUID())).rejects.toThrow();
    await expect(sendManualErrorEvent(diagnostic, canary)).rejects.toThrow();
    expect(outgoing).toEqual([]);
  });
  test("automatic exceptions contain no raw provider text and retry only transient failures", async () => {
    consent(true);
    recordError(failure(), { operation: "file_upload" });
    const statuses = [503, 200];
    globalThis.fetch = async (_input, init) => { outgoing.push(String(init?.body)); return new Response(null, { status: statuses.shift() ?? 200 }); };
    await flushAnalytics(); await flushAnalytics();
    expect(outgoing).toHaveLength(2);
    expect(outgoing[0]).toBe(outgoing[1]);
    expect(outgoing[0]).not.toContain(canary);
    expect(JSON.parse(outgoing[0]).batch[0].event).toBe("$exception");
    globalThis.fetch = async (_input, init) => { outgoing.push(String(init?.body)); return new Response(null, { status: 400 }); };
    recordError(new TypeError(canary), { operation: "render" });
    await flushAnalytics(); await flushAnalytics();
    expect(outgoing).toHaveLength(3);
  });
  test("withdrawn consent cannot resurrect an in-flight failed batch", async () => {
    consent(true); recordError(new RangeError(canary), { operation: "update" });
    let resolveResponse: (value: Response) => void = () => {};
    globalThis.fetch = () => new Promise(resolve => { resolveResponse = resolve; });
    const pending = flushAnalytics();
    discardPendingAnalytics(); consent(false); consent(true);
    resolveResponse(new Response(null, { status: 503 })); await pending;
    globalThis.fetch = async (_input, init) => { outgoing.push(String(init?.body)); return Response.json({}); };
    await flushAnalytics(); expect(outgoing).toEqual([]);
  });
});
