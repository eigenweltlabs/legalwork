import { afterEach, beforeEach, describe, expect, test } from "bun:test";
process.env.VITE_LEGALWORK_POSTHOG_KEY = "phc_test_dummy_key";
const { recordError, getErrorReports, makeErrorReport, submitErrorReport, clearLocalErrorReports, restoreLocalErrorReports } = await import("../src/app/lib/error-reports");
const { flushAnalytics, disposeAnalytics, setAnalyticsConsentOverride, discardPendingAnalytics } = await import("../src/app/lib/analytics");
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
  test("keeps a local incident and sends exactly the preview only on explicit submission", async () => {
    const diagnostic = recordError(failure(), { operation: "run", providerId: canary, modelId: "anthropic/claude-opus-4.6" });
    if (!diagnostic) throw new Error("missing_diagnostic");
    await flushAnalytics();
    expect(outgoing).toEqual([]);
    expect(getErrorReports()).toContain(diagnostic);
    expect(storage.get("legalwork.error-incidents.v1")).not.toContain(canary);
    const report = makeErrorReport(diagnostic, crypto.randomUUID(), "I clicked Send.");
    const preview = JSON.stringify(report);
    const receipt = await submitErrorReport(report, async (url, init) => {
      expect(String(url)).toBe("https://platform.eigenweltlabs.com/api/public/error-reports");
      expect(init?.credentials).toBe("omit");
      outgoing.push(String(init?.body));
      return Response.json({ report_id: report.report_id, received_at: new Date().toISOString() });
    });
    expect(receipt).toBe(report.report_id);
    expect(outgoing).toEqual([preview]);
    expect(preview).not.toContain(canary);
    expect(JSON.parse(storage.get("legalwork.preferences") ?? "{}").analyticsEnabled).toBe(false);
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
  test("requires a matching receipt and can retry the same report after a lost response", async () => {
    const diagnostic = recordError(failure());
    if (!diagnostic) throw new Error("missing_diagnostic");
    const report = makeErrorReport(diagnostic, crypto.randomUUID());
    await expect(submitErrorReport(report, async () => Response.json({ report_id: crypto.randomUUID(), received_at: new Date().toISOString() }))).rejects.toThrow("not_confirmed");
    await expect(submitErrorReport(report, async () => new Response(null, { status: 503 }))).rejects.toThrow("not_received");
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); throw new Error("offline"); };
    await expect(submitErrorReport(report, fetchImpl)).rejects.toThrow("offline");
    await expect(submitErrorReport(report, fetchImpl)).rejects.toThrow("offline");
    expect(bodies[0]).toBe(bodies[1]);
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
