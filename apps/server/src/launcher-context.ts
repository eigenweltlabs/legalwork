import { randomBytes } from "node:crypto";
import type { AssistantContextItem, LauncherStagedContext } from "@legalwork/types/launcher";

const DEFAULT_TTL_MS = 5 * 60_000;
const INVOCATION_MEMORY_MS = 10 * 60_000;
const MAX_STAGED = 200;

/**
 * Short-lived staged context for external entry points. A Raycast command or
 * a deep link carries only this opaque ID; the selection, files or clipboard
 * text stay on this machine, expire, and are handed out once.
 */
export class LauncherContextStore {
  private staged = new Map<string, LauncherStagedContext>();
  private invocations = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  private sweep() {
    const now = this.now();
    for (const [id, entry] of this.staged) if (entry.expiresAt <= now) this.staged.delete(id);
    for (const [id, seen] of this.invocations) if (seen + INVOCATION_MEMORY_MS <= now) this.invocations.delete(id);
  }
  stage(items: AssistantContextItem[], source: LauncherStagedContext["source"], ttlMs = DEFAULT_TTL_MS): LauncherStagedContext {
    this.sweep();
    while (this.staged.size >= MAX_STAGED) {
      const oldest = this.staged.keys().next();
      if (oldest.done) break;
      this.staged.delete(oldest.value);
    }
    const now = this.now();
    const entry: LauncherStagedContext = { id: `ctx_${randomBytes(16).toString("hex")}`, items, source, createdAt: now, expiresAt: now + Math.min(Math.max(ttlMs, 1000), 30 * 60_000) };
    this.staged.set(entry.id, entry);
    return entry;
  }
  /** Returns the staged items exactly once; a second consumer sees nothing. */
  consume(id: string): LauncherStagedContext | null {
    this.sweep();
    const entry = this.staged.get(id) ?? null;
    if (entry) this.staged.delete(id);
    return entry;
  }
  peek(id: string): Pick<LauncherStagedContext, "id" | "source" | "createdAt" | "expiresAt"> & { items: number } | null {
    this.sweep();
    const entry = this.staged.get(id);
    return entry ? { id: entry.id, source: entry.source, createdAt: entry.createdAt, expiresAt: entry.expiresAt, items: entry.items.length } : null;
  }
  /** True the first time an invocation ID is seen; retries and duplicate URL delivery return false. */
  rememberInvocation(id: string): boolean {
    this.sweep();
    if (this.invocations.has(id)) return false;
    this.invocations.set(id, this.now());
    return true;
  }
}
