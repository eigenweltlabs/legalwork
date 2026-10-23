import { expect, test } from "bun:test";
import { startRequestPolling } from "../src/app/lib/request-poller";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function clock() {
  const jobs: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  return { jobs, schedule: (callback: () => void, ms: number) => {
    const job = { callback, ms, cancelled: false }; jobs.push(job);
    return () => { job.cancelled = true; };
  }, tick: () => { const job = jobs.find(job => !job.cancelled); if (job) { job.cancelled = true; job.callback(); } } };
}

test("a slow request never overlaps, and many event wakeups coalesce once", async () => {
  const time = clock(); let calls = 0; let finish = () => {};
  const poll = startRequestPolling(async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); }, { intervalMs: 3000, schedule: time.schedule });
  for (let i = 0; i < 100; i++) poll.wake();
  expect(calls).toBe(1); expect(time.jobs).toHaveLength(0);
  finish(); await settle(); expect(time.jobs.at(-1)?.ms).toBe(0);
  time.tick(); expect(calls).toBe(2);
  poll.stop(); finish(); await settle();
  expect(time.jobs.filter(job => !job.cancelled)).toHaveLength(0);
});

test("failures back off, success restores cadence, and cleanup aborts", async () => {
  const time = clock(); let fail = true; let signal: AbortSignal | undefined;
  const poll = startRequestPolling(async current => { signal = current; if (fail) throw new Error("offline"); }, { intervalMs: 3000, schedule: time.schedule });
  await settle(); expect(time.jobs.at(-1)?.ms).toBe(6000);
  time.tick(); await settle(); expect(time.jobs.at(-1)?.ms).toBe(12000);
  fail = false; time.tick(); await settle(); expect(time.jobs.at(-1)?.ms).toBe(3000);
  poll.stop(); expect(signal?.aborted).toBe(true);
  poll.wake(); await settle(); expect(time.jobs.filter(job => !job.cancelled)).toHaveLength(0);
});

test("an event-only poll still wakes, without creating a fallback loop", async () => {
  const time = clock(); let calls = 0;
  const poll = startRequestPolling(async () => { calls++; }, { intervalMs: () => false, schedule: time.schedule });
  await settle(); expect(calls).toBe(1); expect(time.jobs).toHaveLength(0);
  poll.wake(); await settle(); expect(calls).toBe(2); expect(time.jobs).toHaveLength(0);
  poll.stop();
});
