import { expect, test } from "bun:test";
import { registerBoundedProviderRetries } from "./bounded-provider-retries.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

test("native retry policy preserves the existing two retries and stops terminal failures", async () => {
  const runtime = nativePluginTestRuntime();
  await registerBoundedProviderRetries(runtime.ctx);
  for (const attempt of [2, 3]) {
    const event = { attempt, error: { message: "503 Service unavailable" }, decision: { retry: true, delay: 1000 } };
    await runtime.hook("session", "retry", event);
    expect(event.decision).toEqual({ retry: true, delay: 1000 });
  }
  for (const [attempt, message] of [[4, "503 Service unavailable"], [2, "Invalid API key"], [2, "Budget exceeded"], [2, "Usage pricing is unavailable, HTTP 503"]]) {
    const event = { attempt, error: { message }, decision: { retry: true, delay: 1000 } };
    await runtime.hook("session", "retry", event);
    expect(event.decision).toMatchObject({ retry: false });
    expect("delay" in event.decision).toBe(false);
  }
});
