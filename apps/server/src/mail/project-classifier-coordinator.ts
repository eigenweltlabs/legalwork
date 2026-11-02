import type { MailClassifierPlan } from './classifier-incoming-view.js';
import type { MailProjectDestination, MailProjectReference } from './project-association-view.js';

type Options = {
  pending: () => Promise<{ items: MailClassifierPlan[] }>;
  commit: (plan: MailClassifierPlan, project: MailProjectReference | null) => Promise<unknown>;
  resolve: (id: string) => Promise<MailProjectDestination>;
  canRun: () => boolean;
  idleMs?: number;
  resolveTimeoutMs?: number;
};

/** Resolves current host project access; the worker owns validation and the transaction. */
export class MailProjectClassifierCoordinator {
  private running = false;
  private epoch = 0;
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;

  constructor(private options: Options) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.epoch++;
    this.schedule(0);
  }
  stop() {
    this.running = false;
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
  }
  wake() {
    if (this.running && !this.active) {
      clearTimeout(this.timer);
      this.schedule(0);
    }
  }
  private schedule(ms: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.turn(); }, ms);
    this.timer.unref();
  }
  private resolve(plan: MailClassifierPlan, signal: AbortSignal) {
    return new Promise<MailProjectReference | null>(finish => {
      let settled = false;
      const done = (value: MailProjectReference | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        finish(value);
      };
      const cancel = () => done(null);
      const timer = setTimeout(cancel, this.options.resolveTimeoutMs ?? 5000);
      timer.unref();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      void Promise.resolve().then(() => this.options.resolve(plan.project.id))
        .then(project => done(project.id === plan.project.id && project.binding === plan.project.binding
          ? { id: project.id, binding: project.binding } : null))
        .catch(() => done(null));
    });
  }
  private async turn() {
    if (!this.running || this.active) return;
    this.active = true;
    const epoch = this.epoch;
    let busy = false;
    const current = () => this.running && epoch === this.epoch && this.options.canRun();
    try {
      if (!current()) return;
      const page = await this.options.pending();
      if (!current()) return;
      busy = page.items.length > 0;
      for (const plan of page.items) {
        if (!current()) return;
        const abort = new AbortController();
        this.abort = abort;
        const project = await this.resolve(plan, abort.signal);
        this.abort = undefined;
        if (!current()) return;
        await this.options.commit(plan, project);
      }
    } catch {
      // Durable pending rows survive a transient worker or host failure.
      busy = false;
    } finally {
      this.active = false;
      if (this.running) this.schedule(busy ? 0 : this.options.idleMs ?? 5000);
    }
  }
}
