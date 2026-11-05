type Statuses = Record<string, { status: string }>;
type Connector = { name: string; config: Record<string, unknown>; disabledByTools?: boolean };
type Attempt = { retryAt: number; pending?: Promise<void> };

/** Reconnect transports without editing configuration, removing tokens, or replaying tools. */
export class McpRecovery {
  private attempts = new Map<string, Attempt>();
  private queues = new Map<string, Promise<void>>();
  private mutations = new Map<string, number>();
  private authorizing = new Map<string, number>();

  constructor(private now = Date.now, private retryDelayMs = 30_000) {}

  private enqueue<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(name) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => {}, () => {});
    this.queues.set(name, settled);
    void settled.then(() => { if (this.queues.get(name) === settled) this.queues.delete(name); });
    return result;
  }

  /** Manual changes finish after earlier reconnects, before acknowledging success. */
  async mutate<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.mutations.set(name, (this.mutations.get(name) ?? 0) + 1);
    try { return await this.enqueue(name, operation); }
    finally {
      const remaining = this.mutations.get(name)! - 1;
      if (remaining) this.mutations.set(name, remaining);
      else this.mutations.delete(name);
    }
  }

  beginAuth(name: string, expiresAt = this.now() + 5 * 60_000): void {
    // Native attempts supply their engine-owned expiry. The default supports
    // callers without an attempt yet; active requests also hold mutate().
    this.authorizing.set(name, expiresAt);
  }

  endAuth(name: string): void { this.authorizing.delete(name); }

  private paused(name: string): boolean {
    const until = this.authorizing.get(name);
    if (until !== undefined && until <= this.now()) this.authorizing.delete(name);
    return this.mutations.has(name) || this.authorizing.has(name);
  }

  async recover(input: {
    engine: string;
    directory: string;
    statuses: Statuses;
    connectors: () => Promise<Connector[]>;
    readStatuses: () => Promise<Statuses>;
    connect: (name: string) => Promise<unknown>;
  }): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [name, status] of Object.entries(input.statuses)) {
      if (this.paused(name)) continue;
      const key = JSON.stringify([input.engine, input.directory, name]);
      const previous = this.attempts.get(key);
      if (status.status !== "failed") {
        if (!previous?.pending) this.attempts.delete(key);
        continue;
      }
      if (previous?.pending) {
        pending.push(previous.pending);
        continue;
      }
      if (previous && previous.retryAt > this.now()) continue;
      const attempt: Attempt = { retryAt: this.now() + this.retryDelayMs };
      this.attempts.set(key, attempt);
      // Engine instances/processes share credentials keyed by connector name.
      const operation = this.enqueue(name, async () => {
        if (this.paused(name)) return;
        const connector = (await input.connectors()).find(item => item.name === name);
        if (!connector || connector.config.type !== "remote" || connector.config.enabled === false || connector.disabledByTools) return;
        // A manual disconnect or sign-in may have happened while queued.
        if ((await input.readStatuses())[name]?.status !== "failed" || this.paused(name)) return;
        await input.connect(name);
      }).catch(() => {
        // The engine retains its per-connector error. A later refresh retries.
      }).finally(() => {
        attempt.pending = undefined;
        attempt.retryAt = this.now() + this.retryDelayMs;
      });
      attempt.pending = operation;
      pending.push(operation);
    }
    await Promise.all(pending);
  }
}
