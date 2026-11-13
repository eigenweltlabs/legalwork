import type { LauncherDraft, LauncherDraftFile, DraftLease, AssistantSubmission } from "@legalwork/types/launcher";
export type { LauncherDraft, DraftLease } from "@legalwork/types/launcher";
export type DraftFile = LauncherDraftFile;
export type DraftStorage = { read: () => Promise<DraftFile>; write: (file: DraftFile, expectedVersion: number) => Promise<boolean> };
export type DraftMessage = { file: DraftFile };
export const EMPTY_DRAFT_FILE: DraftFile = { version: 0, drafts: {}, leases: {} };

export function emptyLauncherDraft(conversationId: string, now = Date.now()): LauncherDraft {
  return { conversationId, revision: 0, text: "", context: [], target: { kind: "assistant" }, searchScope: null, pendingTranscription: null, model: null, variant: null, submission: null, updatedAt: now };
}
export function isDraftEmpty(draft: LauncherDraft) {
  return !draft.text.trim() && !draft.context.length && !draft.pendingTranscription && !draft.submission;
}

/** A renderer cache, never a write authority. The shared store accepts a write
 * only against its current version, including all editor ownership changes. */
export class DraftCoordinator {
  private file: DraftFile = structuredClone(EMPTY_DRAFT_FILE);
  private loaded: Promise<void> | null = null;
  private listeners = new Set<(conversationId: string) => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private protectedWork = new Map<string, number>();
  constructor(private storage: DraftStorage, private channel?: { post: (message: DraftMessage) => void; subscribe: (listener: (message: DraftMessage) => void) => () => void }, private now: () => number = Date.now) {
    channel?.subscribe(message => this.adopt(message.file));
  }
  private adopt(file: DraftFile) {
    if (file.version < this.file.version) return;
    const previous = this.file;
    this.file = file;
    for (const id of new Set([...Object.keys(previous.drafts), ...Object.keys(file.drafts), ...Object.keys(previous.leases), ...Object.keys(file.leases)])) {
      if (previous.drafts[id]?.revision !== file.drafts[id]?.revision || previous.leases[id]?.owner !== file.leases[id]?.owner)
        for (const listener of this.listeners) listener(id);
    }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writes.catch(() => {}).then(action);
    this.writes = operation;
    return operation;
  }
  private async transact(change: (file: DraftFile) => void) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await this.storage.read();
      const next = structuredClone(current);
      try { change(next); } catch (error) { this.adopt(current); throw error; }
      next.version = current.version + 1;
      if (!await this.storage.write(next, current.version)) continue;
      this.adopt(next);
      this.channel?.post({ file: next });
      return next;
    }
    throw new Error("The draft changed in another window. Focus it again before editing.");
  }
  subscribe(listener: (conversationId: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async ready() { this.loaded ??= this.reconcile(); await this.loaded; }
  get(conversationId: string): LauncherDraft { return this.file.drafts[conversationId] ?? emptyLauncherDraft(conversationId, this.now()); }
  lease(conversationId: string): DraftLease | null { return this.file.leases[conversationId] ?? null; }
  owns(conversationId: string, owner: string) { return this.lease(conversationId)?.owner === owner; }
  async claim(conversationId: string, owner: string) {
    // An attachment upload or an explicit handoff must finish before another
    // surface can take its draft. Wait outside the local write queue.
    for (let attempt = 0; ; attempt++) {
      const file = await this.storage.read(), lease = file.leases[conversationId];
      if (!lease?.pending || lease.owner === owner || this.now() - lease.since > 60_000) break;
      if (attempt >= 600) throw new Error("An attachment is still being saved. Please try again when it finishes.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return this.serial(async () => {
      const file = await this.transact(next => {
        const lease = next.leases[conversationId];
        if (lease?.pending && lease.owner !== owner && this.now() - lease.since <= 60_000) throw new Error("An attachment is still being saved.");
        const draft = next.drafts[conversationId] ?? emptyLauncherDraft(conversationId, this.now());
        next.drafts[conversationId] = draft;
        next.leases[conversationId] = { conversationId, owner, revision: draft.revision, since: this.now(), ...(lease?.owner === owner && lease.pending ? { pending: true } : {}) };
      });
      return { draft: file.drafts[conversationId], lease: file.leases[conversationId] };
    });
  }
  async protect<T>(conversationId: string, owner: string, work: () => Promise<T>) {
    const key = JSON.stringify([conversationId, owner]);
    await this.serial(async () => {
      await this.transact(next => {
        const lease = next.leases[conversationId];
        if (lease?.owner !== owner) throw new Error("draft_lease_lost");
        lease.pending = true; lease.since = this.now();
      });
      this.protectedWork.set(key, (this.protectedWork.get(key) ?? 0) + 1);
    });
    const heartbeat = setInterval(() => {
      void this.serial(() => this.transact(next => {
        const lease = next.leases[conversationId];
        if (lease?.owner === owner && lease.pending) lease.since = this.now();
      })).catch(() => undefined);
    }, 15_000);
    try { return await work(); }
    finally {
      clearInterval(heartbeat);
      await this.serial(async () => {
        const remaining = (this.protectedWork.get(key) ?? 1) - 1;
        if (remaining) this.protectedWork.set(key, remaining); else this.protectedWork.delete(key);
        await this.transact(next => { const lease = next.leases[conversationId]; if (lease?.owner === owner) lease.pending = remaining > 0; });
      });
    }
  }
  update(conversationId: string, owner: string, patch: Partial<Omit<LauncherDraft, "conversationId" | "revision" | "updatedAt">>) {
    return this.serial(async () => {
      const expectedRevision = this.get(conversationId).revision;
      const file = await this.transact(next => {
        const lease = next.leases[conversationId];
        if (!lease || lease.owner !== owner) throw new Error("draft_lease_lost");
        const current = next.drafts[conversationId] ?? emptyLauncherDraft(conversationId, this.now());
        if (current.revision !== expectedRevision) throw new Error("draft_revision_changed");
        next.drafts[conversationId] = { ...current, ...patch, conversationId, revision: current.revision + 1, updatedAt: this.now() };
        lease.revision = current.revision + 1;
      });
      return file.drafts[conversationId];
    });
  }
  acknowledgeSubmission(conversationId: string, owner: string, submission: Pick<AssistantSubmission, "requestId" | "messageId" | "state">) {
    return this.serial(async () => {
      const result: { cleared: Pick<LauncherDraft, "text" | "context"> | null } = { cleared: null };
      await this.transact(next => {
        result.cleared = null;
        const current = next.drafts[conversationId], lease = next.leases[conversationId];
        if (lease?.owner !== owner) throw new Error("draft_lease_lost");
        if (!current?.submission || current.submission.requestId !== submission.requestId || current.submission.messageId !== submission.messageId) return;
        const snapshot = current.submission.draftSnapshot;
        if (["accepted", "running", "completed"].includes(submission.state) && snapshot && current.text === snapshot.text && JSON.stringify(current.context) === JSON.stringify(snapshot.context)) {
          result.cleared = { text: current.text, context: current.context };
          current.text = ""; current.context = []; current.pendingTranscription = null; delete current.composer;
        }
        current.submission.state = submission.state;
        current.revision++; current.updatedAt = this.now(); lease.revision = current.revision;
      });
      return result.cleared;
    });
  }
  clear(conversationId: string, owner: string) {
    return this.update(conversationId, owner, { ...emptyLauncherDraft(conversationId, this.now()), model: this.get(conversationId).model, variant: this.get(conversationId).variant });
  }
  release(conversationId: string, owner: string) {
    return this.serial(async () => {
      let released = false;
      await this.transact(next => {
        if (next.leases[conversationId]?.owner === owner) { delete next.leases[conversationId]; released = true; }
      });
      return released;
    });
  }
  isLeaseStale(conversationId: string) {
    const lease = this.lease(conversationId);
    return Boolean(lease && this.now() - lease.since > 15 * 60_000);
  }
  async reconcile() { this.adopt(await this.storage.read()); }
  async flush() { await this.writes; }
}
