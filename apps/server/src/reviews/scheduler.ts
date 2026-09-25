import { z } from "zod";
import { totalmem } from "node:os";
import { ApiError } from "../errors.js";
import { retryAfterMs } from "../retry-after.js";

export function laptopReviewLimits(memoryBytes: number) {
  // Inference runs remotely. Bound local evidence, JSON payloads and temporary
  // agent sessions; reserve more headroom on laptops with less than 16 GiB RAM.
  return memoryBytes < 16 * 1024 ** 3 ? { cells: 8, documents: 2 } : { cells: 16, documents: 4 };
}
const defaults = laptopReviewLimits(totalmem());
export const REVIEW_CONCURRENCY = {
  cells: limit("LEGALWORK_REVIEW_CELL_CONCURRENCY", defaults.cells),
  documents: limit("LEGALWORK_REVIEW_DOCUMENT_CONCURRENCY", defaults.documents),
};
function limit(name: string, fallback: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return z.coerce.number().int().min(1).max(32).parse(value);
}

export class ReviewRetryError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) { super(message); }
}
const modelErrorSchema = z.object({ message: z.string(), statusCode: z.number().optional(), responseHeaders: z.record(z.string(), z.string()).optional() });
export function reviewModelError(value: unknown, next?: number) {
  const parsed = modelErrorSchema.safeParse(value);
  if (!parsed.success) return new Error("The selected LLM could not complete this cell.");
  const { message, statusCode, responseHeaders } = parsed.data;
  const detail = `The selected LLM could not complete this cell: ${message.slice(0, 1000)}`;
  if (/no credits|insufficient.quota|billing|budget|invalid.api.key|authentication|unauthorized|payment required/i.test(message)) return new Error(detail);
  const retryable = statusCode !== undefined ? [429, 500, 502, 503, 504, 529].includes(statusCode)
    : /rate.?limit|too many requests|overload|temporarily unavailable|\b(?:429|502|503|504|529)\b/i.test(message);
  return retryable ? new ReviewRetryError(detail, Math.max(retryAfterMs(responseHeaders?.["retry-after"] ?? responseHeaders?.["Retry-After"]) ?? 0, next ? next - Date.now() : 0)) : new Error(detail);
}
const detailsSchema = z.object({ retryAfterMs: z.number().nonnegative().optional() });
function transient(error: unknown) {
  if (error instanceof ReviewRetryError) return error;
  // Invalid answers, credentials, billing, and permissions never become retries.
  if (error instanceof ApiError && [429, 502, 503, 504, 529].includes(error.status)
    && ["systemone_rate_limited", "systemone_unavailable", "systemone_timeout"].includes(error.code))
    return new ReviewRetryError(error.message, detailsSchema.safeParse(error.details).data?.retryAfterMs);
}

type Job = {
  group: string; provider: string; signal: AbortSignal;
  run: () => Promise<void>; reject: (error: unknown) => void;
  abort: () => void; running: boolean; attempts: number; readyAt: number;
};
type QueueOptions = { attempts?: number; retryDelayMs?: number; jitterMs?: number };

/** Bounded workers, round-robin between reviews, with provider-scoped cooldowns.
 * A retry releases its worker so another provider/review can make progress.
 */
export class ReviewQueue {
  private groups = new Map<string, Job[]>();
  private cooldowns = new Map<string, number>();
  private active = 0;
  private lastGroup: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly concurrency: number, private options: QueueOptions = {}) {
    z.number().int().min(1).parse(concurrency);
  }
  run<T>(group: string, provider: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        group, provider, signal, reject, running: false, attempts: 0, readyAt: 0,
        run: async () => { const result = await action(); signal.throwIfAborted(); resolve(result); },
        abort: () => {
          if (job.running) return; // Keep the slot until the in-flight request has stopped.
          this.remove(job); signal.removeEventListener("abort", job.abort); reject(signal.reason); this.pump();
        },
      };
      signal.addEventListener("abort", job.abort, { once: true });
      this.enqueue(job); this.pump();
    });
  }
  private enqueue(job: Job) {
    const queue = this.groups.get(job.group);
    if (queue) queue.push(job); else this.groups.set(job.group, [job]);
  }
  private remove(job: Job) {
    const queue = this.groups.get(job.group);
    if (!queue) return;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) this.groups.delete(job.group);
  }
  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    while (this.active < this.concurrency && this.groups.size) {
      const groups = [...this.groups.keys()];
      const start = this.lastGroup === undefined ? 0 : (groups.indexOf(this.lastGroup) + 1) % groups.length;
      let next: Job | undefined, wakeAt = Infinity;
      for (let offset = 0; offset < groups.length && !next; offset++) {
        for (const job of this.groups.get(groups[(start + offset) % groups.length])!) {
          const at = Math.max(job.readyAt, this.cooldowns.get(job.provider) ?? 0);
          if (at <= Date.now()) { next = job; break; }
          wakeAt = Math.min(wakeAt, at);
        }
      }
      if (!next) {
        if (Number.isFinite(wakeAt)) this.timer = setTimeout(() => this.pump(), Math.min(2_147_483_647, Math.max(1, wakeAt - Date.now())));
        return;
      }
      this.remove(next); this.lastGroup = next.group;
      next.running = true; this.active++;
      void this.execute(next);
    }
    for (const [provider, until] of this.cooldowns) if (until <= Date.now()) this.cooldowns.delete(provider);
  }
  private async execute(job: Job) {
    let retry = false;
    try { job.signal.throwIfAborted(); job.attempts++; await job.run(); }
    catch (error) {
      const recoverable = !job.signal.aborted && transient(error);
      if (recoverable) {
        const backoff = (this.options.retryDelayMs ?? 1000) * 2 ** (job.attempts - 1);
        const wait = Math.max(recoverable.retryAfterMs ?? 0, backoff) + Math.random() * (this.options.jitterMs ?? 250);
        job.readyAt = Date.now() + wait;
        this.cooldowns.set(job.provider, Math.max(job.readyAt, this.cooldowns.get(job.provider) ?? 0));
        retry = job.attempts < (this.options.attempts ?? 1);
      }
      if (!retry) job.reject(job.signal.aborted ? job.signal.reason : error);
    } finally {
      job.running = false; this.active--;
      if (retry && !job.signal.aborted) this.enqueue(job);
      else { job.signal.removeEventListener("abort", job.abort); if (retry) job.reject(job.signal.reason); }
      this.pump();
    }
  }
}

export class ReviewScheduler {
  readonly documents: ReviewQueue;
  readonly cells: ReviewQueue;
  constructor(limits = REVIEW_CONCURRENCY) {
    this.documents = new ReviewQueue(limits.documents);
    this.cells = new ReviewQueue(limits.cells);
  }
}

/** Inference has its own queues: chunk requests retry without repeating successful chunks. */
export class ReviewRequests {
  private queue: ReviewQueue;
  constructor(limits = REVIEW_CONCURRENCY, retry: { attempts?: number; retryDelayMs?: number; jitterMs?: number } = {}) {
    this.queue = new ReviewQueue(limits.cells, { attempts: 3, ...retry });
  }
  run<T>(backend: "systemone" | "llm", group: string, provider: string, signal: AbortSignal, action: () => Promise<T>) {
    return this.queue.run(group, `${backend}:${provider}`, signal, action);
  }
}
