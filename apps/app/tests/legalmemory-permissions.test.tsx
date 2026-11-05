import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { legalMemoryInterfaceActivities, cancelLegalMemoryInterfaceReads, subscribeLegalMemoryInterfaceActivities } from "../src/app/lib/legalmemory-interface-activity";
import { LegalMemoryPermissionNotice } from "../src/react-app/domains/connections/legalmemory-permissions";
import { Dialog } from "../src/components/ui/dialog";

const originalFetch = globalThis.fetch;
afterEach(async () => { cancelLegalMemoryInterfaceReads(); globalThis.fetch = originalFetch; await Promise.resolve(); });

test("LegalMemory approval notice shows exact native action/resources and firm message without chat selection", () => {
  const permission = { operationID: "private-operation", requestID: "request", action: "legalmemory_find_related_documents", resources: ["*", "complete resource"], message: "Your firm requires approval." };
  const html = renderToStaticMarkup(<Dialog open><LegalMemoryPermissionNotice workspace="Matter A" permission={permission} onReply={() => {}} /></Dialog>);
  expect(html).toContain("legalmemory_find_related_documents"); expect(html).toContain("complete resource"); expect(html).toContain("Your firm requires approval."); expect(html).toContain("Matter A");
  expect(html).toContain("Allow this read"); expect(html).toContain("Deny"); expect(html).not.toContain("private-operation");
});

test("only in-flight LegalMemory reads activate shared approval observation; caller cancellation ends observation", async () => {
  const signals: AbortSignal[] = [];
  globalThis.fetch = Object.assign((async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Native compatibility reads must be cancellable");
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  }), { preconnect: originalFetch.preconnect });
  const client = createLegalworkServerClient({ baseUrl: "http://localhost:1234", token: "fixture" });
  expect(legalMemoryInterfaceActivities()).toHaveLength(0);
  let notifications = 0; const unsubscribe = subscribeLegalMemoryInterfaceActivities(() => notifications++);
  const controller = new AbortController();
  const first = client.legalMemoryTreeRoots("workspace", { signal: controller.signal });
  const second = client.legalMemoryGraph("workspace", { document_id: "source" });
  expect(legalMemoryInterfaceActivities()).toHaveLength(1);
  controller.abort(); await expect(first).rejects.toBeDefined();
  expect(legalMemoryInterfaceActivities()).toHaveLength(1);
  cancelLegalMemoryInterfaceReads(); await expect(second).rejects.toBeDefined();
  expect(legalMemoryInterfaceActivities()).toHaveLength(0); expect(signals.every(signal => signal.aborted)).toBe(true); expect(notifications).toBe(2); unsubscribe();
});

test("approval list/reply uses typed LegalWork metadata endpoints and preserves authentication separation", async () => {
  const requests: Array<{ url: string; body?: string; authorization: string | null }> = [];
  let complete: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === "string" ? init.body : undefined, authorization: new Headers(init?.headers).get("authorization") });
    if (!url.endsWith("/permissions")) return new Promise<Response>(resolve => { complete = resolve; });
    return Response.json(init?.method === "POST" ? { replied: true } : { workspace: { id: "workspace", name: "Matter" }, requests: [{ operationID: "operation", requestID: "request", action: "legalmemory_list_connectors", resources: ["*"] }] });
  }), { preconnect: originalFetch.preconnect });
  const client = createLegalworkServerClient({ baseUrl: "http://localhost:1234", token: "fixture-person" });
  const pending = client.legalMemoryTreeRoots("workspace");
  const activity = legalMemoryInterfaceActivities()[0];
  expect((await activity.permissions()).requests[0].action).toBe("legalmemory_list_connectors");
  expect(await activity.reply({ operationID: "operation", requestID: "request", decision: "once" })).toEqual({ replied: true });
  expect(requests.at(-1)?.body).toBe(JSON.stringify({ operationID: "operation", requestID: "request", decision: "once" }));
  expect(requests.every(request => request.authorization === "Bearer fixture-person")).toBe(true);
  expect(requests.some(request => request.url.includes("/session/"))).toBe(false);
  complete?.(Response.json({ roots: [] })); await pending; expect(legalMemoryInterfaceActivities()).toHaveLength(0);
});
