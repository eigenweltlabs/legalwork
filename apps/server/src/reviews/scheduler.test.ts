import { expect, test } from "bun:test";
import { ApiError } from "../errors.js";
import { retryAfterMs } from "../retry-after.js";
import { ReviewQueue, ReviewRequests, ReviewRetryError, reviewModelError, laptopReviewLimits } from "./scheduler.js";

function gate() {
  let open = () => {};
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}
const signal = () => new AbortController().signal;
async function until(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(2);
  expect(condition()).toBe(true);
}

test("bounds workers and rotates between reviews instead of draining the first review", async () => {
  const queue = new ReviewQueue(2), first = gate();
  const order: string[] = [];
  let active = 0, peak = 0;
  const work = (group: string, block = false) => queue.run(group, "provider", signal(), async () => {
    order.push(group); peak = Math.max(peak, ++active);
    if (block) await first.wait;
    await Bun.sleep(2); active--;
  });
  const jobs = [work("a", true), work("a", true), work("a"), work("a"), work("b"), work("b"), work("c")];
  expect(order).toEqual(["a", "a"]);
  first.open(); await Promise.all(jobs);
  expect(peak).toBe(2); expect(order.slice(2, 5)).toEqual(["b", "c", "a"]);
});

test("cancels queued work immediately, but keeps running slots until cleanup finishes", async () => {
  const queue = new ReviewQueue(1), running = gate(), controller = new AbortController();
  let executed = 0;
  const first = queue.run("a", "p", controller.signal, async () => { await running.wait; });
  const firstResult = first.catch(error => error);
  const queued = queue.run("a", "p", controller.signal, async () => { executed++; });
  const queuedResult = queued.catch(error => error);
  controller.abort(new Error("Cancelled"));
  expect((await queuedResult).message).toBe("Cancelled");
  const next = queue.run("b", "p", signal(), async () => { executed++; });
  await Bun.sleep(5); expect(executed).toBe(0);
  running.open(); expect((await firstResult).message).toBe("Cancelled");
  await next; expect(executed).toBe(1);
});

test("rate limits cool down only their provider, honor Retry-After, and release the worker", async () => {
  const queue = new ReviewQueue(1, { attempts: 3, retryDelayMs: 1, jitterMs: 0 });
  const order: string[] = [];
  let attempts = 0, firstAt = 0;
  const first = queue.run("a", "limited", signal(), async () => {
    order.push("limited");
    if (++attempts === 1) { firstAt = Date.now(); throw new ReviewRetryError("busy", 50); }
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(49);
    return "ok";
  });
  const sibling = queue.run("b", "limited", signal(), async () => { order.push("sibling"); expect(Date.now() - firstAt).toBeGreaterThanOrEqual(49); });
  const other = queue.run("c", "other", signal(), async () => { order.push("other"); });
  await other; expect(order).toEqual(["limited", "other"]);
  expect(await first).toBe("ok"); await sibling; expect(attempts).toBe(2);
});

test("retries are bounded and cancellation interrupts a long provider cooldown", async () => {
  const queue = new ReviewQueue(1, { attempts: 3, retryDelayMs: 1, jitterMs: 0 });
  let attempts = 0;
  await expect(queue.run("a", "p", signal(), async () => { attempts++; throw new ApiError(503, "systemone_unavailable", "down"); })).rejects.toThrow("down");
  expect(attempts).toBe(3);
  const controller = new AbortController();
  const job = queue.run("b", "other", controller.signal, async () => { attempts++; throw new ReviewRetryError("busy", 60_000); });
  const result = job.catch(error => error);
  await until(() => attempts === 4);
  controller.abort(new Error("Stopped"));
  expect((await result).message).toBe("Stopped");
  await queue.run("c", "healthy", signal(), async () => {});
});

test("authentication, billing and invalid output never retry", async () => {
  const queue = new ReviewQueue(1, { attempts: 3, retryDelayMs: 1, jitterMs: 0 });
  for (const error of [
    new ApiError(401, "systemone_authentication", "reconnect"),
    new ApiError(502, "systemone_invalid_response", "invalid"),
    reviewModelError({ message: "insufficient_quota", statusCode: 429 }),
    reviewModelError({ message: "You have no credits remaining.", statusCode: 429 }),
    new Error("Invented citation"),
  ]) {
    let calls = 0;
    await expect(queue.run("a", "p", signal(), async () => { calls++; throw error; })).rejects.toThrow();
    expect(calls).toBe(1);
  }
  expect(reviewModelError({ message: "Busy", statusCode: 429, responseHeaders: { "retry-after": "3" } })).toMatchObject({ retryAfterMs: 3000 });
  expect(retryAfterMs("garbage")).toBeUndefined(); expect(retryAfterMs("0.5")).toBe(500);
  expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
});

test("all backends share the local request ceiling; JEV alone can use every slot", async () => {
  for (const mixed of [false, true]) {
    const requests = new ReviewRequests({ cells: 16, documents: 4 }), done = gate();
    let active = 0, peak = 0;
    const jobs = Array.from({ length: 24 }, (_, i) => requests.run(mixed && i % 2 ? "llm" : "systemone", `review-${i % 3}`, "p", signal(), async () => {
      peak = Math.max(peak, ++active); await done.wait; active--;
    }));
    expect(active).toBe(16);
    done.open(); await Promise.all(jobs); expect(peak).toBe(16);
  }
});

test("laptop defaults reserve extra memory on smaller machines", () => {
  expect(laptopReviewLimits(8 * 1024 ** 3)).toEqual({ cells: 8, documents: 2 });
  expect(laptopReviewLimits(16 * 1024 ** 3)).toEqual({ cells: 16, documents: 4 });
  expect(laptopReviewLimits(36 * 1024 ** 3)).toEqual({ cells: 16, documents: 4 });
});
