import { expect, test } from "bun:test";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";
import { isNativeReviewWorker, registerPrimaryContext } from "./native-review-worker.js";
import { registerAppStateReminders } from "./native-app-state-reminders.js";
import { registerBoundedProviderRetries } from "./bounded-provider-retries.js";

test("only saved internal document extractors skip unrelated app guidance and reminders", async () => {
  const runtime = nativePluginTestRuntime();
  runtime.sessions.set("worker", { agent: "document-extractor", metadata: { legalworkReviewWorker: true, legalworkReviewClaim: "server-bound" } });
  runtime.sessions.set("selected", { agent: "document-extractor" });
  runtime.sessions.set("forged", { agent: "legalwork", metadata: { legalworkReviewWorker: true, legalworkReviewClaim: "invented" } });
  let reads = 0;
  const stop = await registerAppStateReminders(runtime.ctx, { topic: "office", read: async () => { reads++; return "Unrelated.docx"; }, cleared: "Closed" });
  await registerPrimaryContext(runtime.ctx, event => { event.system.push({ type: "text", text: "Normal capabilities" }); });
  try {
    for (const sessionID of ["worker", "selected", "forged"]) {
      const worker = sessionID === "worker";
      expect(await isNativeReviewWorker(runtime.ctx, sessionID)).toBe(worker);
      const context = { sessionID, system: [] };
      await runtime.hook("session", "context", context);
      expect(context.system).toHaveLength(worker ? 0 : 1);
      const prompt = { sessionID, messageID: "msg", prompt: { text: "Review evidence." } };
      await runtime.hook("session", "prompt", prompt);
      expect(prompt.prompt.text.includes("Unrelated.docx")).toBe(!worker);
    }
    expect(reads).toBe(2);
  } finally { stop(); await runtime.close(); }
});
test("bounded retries never turn a worker's existing no-retry decision back on", async () => {
  const runtime = nativePluginTestRuntime(); await registerBoundedProviderRetries(runtime.ctx);
  const event = { attempt: 1, error: { message: "503 temporarily unavailable" }, decision: { retry: false } };
  await runtime.hook("session", "retry", event); expect(event.decision).toEqual({ retry: false });
  await runtime.close();
});
