/** Test checkpoints only: callers decide where real adapter/storage boundaries are. */
export type Checkpoint = "page:before" | "message:before" | "chunk:before" | "content:durable" | "cursor:before" | "cursor:durable" | "submit:before" | "submit:accepted" | "submit:recorded";
export type FaultCode = "restart" | "network-loss" | "throttled" | "disk-full" | "cursor-expired" | "remote-edit" | "uncertain-submission";
export interface FaultRule { checkpoint: Checkpoint; occurrence: number; code: FaultCode; retryAfterMs?: number }
export interface CheckpointEvent { sequence: number; checkpoint: Checkpoint; occurrence: number; fault?: FaultCode }
export class InjectedFault extends Error {
  constructor(public readonly rule: Readonly<FaultRule>) {
    super(`Injected ${rule.code} at ${rule.checkpoint} #${rule.occurrence}`);
    this.name = "InjectedFault";
  }
}
/** Each rule fires once. Retain across simulated restarts, or reconstruct for replay.
 * Observer is optional: keep bounded diagnostics externally on long runs. */
export class FaultInjector {
  private readonly rules: Readonly<FaultRule>[];
  private readonly counts = new Map<Checkpoint, number>();
  private sequence = 0;
  constructor(rules: FaultRule[] = [], private readonly observe?: (event: CheckpointEvent) => void) {
    const seen = new Set<string>();
    this.rules = rules.map(rule => {
      if (!Number.isSafeInteger(rule.occurrence) || rule.occurrence < 1) throw new RangeError("occurrence must be a positive safe integer");
      if (rule.retryAfterMs !== undefined && (!Number.isFinite(rule.retryAfterMs) || rule.retryAfterMs < 0)) throw new RangeError("retryAfterMs must be nonnegative");
      const key = `${rule.checkpoint}:${rule.occurrence}`;
      if (seen.has(key)) throw new Error(`Ambiguous fault rules at ${key}`);
      seen.add(key);
      return Object.freeze({ ...rule });
    });
  }
  hit(checkpoint: Checkpoint): void {
    const occurrence = (this.counts.get(checkpoint) ?? 0) + 1;
    this.counts.set(checkpoint, occurrence);
    const rule = this.rules.find(rule => rule.checkpoint === checkpoint && rule.occurrence === occurrence);
    this.observe?.({ sequence: ++this.sequence, checkpoint, occurrence, ...(rule ? { fault: rule.code } : {}) });
    if (rule) throw new InjectedFault(rule);
  }
}
