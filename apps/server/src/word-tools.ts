/**
 * Relay for tools that execute inside a connected Word task pane.
 *
 * The agent (an OpenCode plugin) calls `execute`; the pane long-polls for
 * requests, runs them through Office.js, and posts results back. Mirrors the
 * ApprovalService pattern: pending requests live in memory and resolve when
 * the client answers or the timeout fires. Office.js only exists inside the
 * pane's webview, so this hop is unavoidable.
 */
import { shortId } from "./utils.js";

export type WordToolRequest = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
};

export type WordToolExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

const NO_CLIENT_ERROR =
  "No Word pane is connected for this workspace. Ask the user to open the LegalWork pane in Microsoft Word.";

const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;
const MAX_EXECUTE_TIMEOUT_MS = 120_000;
const MAX_POLL_WAIT_MS = 30_000;
/** A pane counts as connected if it polled within this window. */
const CLIENT_LIVENESS_MS = 40_000;

type PendingExecution = {
  request: WordToolRequest;
  resolve: (result: WordToolExecutionResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PollWaiter = {
  resolve: (requests: WordToolRequest[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WordToolRelay {
  /** Requests not yet handed to a poller, per workspace. */
  private queues = new Map<string, WordToolRequest[]>();
  /** All in-flight requests by id (queued or delivered), awaiting a result. */
  private pending = new Map<string, PendingExecution>();
  private waiters = new Map<string, PollWaiter[]>();
  private lastPollAt = new Map<string, number>();
  /** Open-document identity as last reported by the pane's polls. */
  private lastDocumentUrl = new Map<string, string>();

  clientConnected(workspaceId: string): boolean {
    if ((this.waiters.get(workspaceId)?.length ?? 0) > 0) return true;
    const last = this.lastPollAt.get(workspaceId) ?? 0;
    return Date.now() - last < CLIENT_LIVENESS_MS;
  }

  /** URL/path of the document open next to the connected pane, if reported. */
  documentUrl(workspaceId: string): string | null {
    if (!this.clientConnected(workspaceId)) return null;
    return this.lastDocumentUrl.get(workspaceId) ?? null;
  }

  execute(
    workspaceId: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<WordToolExecutionResult> {
    if (!this.clientConnected(workspaceId)) {
      return Promise.resolve({ ok: false, error: NO_CLIENT_ERROR });
    }

    const request: WordToolRequest = {
      id: shortId(),
      tool,
      args,
      createdAt: Date.now(),
    };
    const timeout = Math.min(
      Math.max(timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS, 1_000),
      MAX_EXECUTE_TIMEOUT_MS,
    );

    return new Promise<WordToolExecutionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const queue = this.queues.get(workspaceId);
        if (queue) {
          this.queues.set(
            workspaceId,
            queue.filter((entry) => entry.id !== request.id),
          );
        }
        resolve({
          ok: false,
          error: `The Word pane did not answer within ${Math.round(timeout / 1000)}s. The document may be busy or the pane was closed.`,
        });
      }, timeout);
      this.pending.set(request.id, { request, resolve, timer });

      const waiter = this.waiters.get(workspaceId)?.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve([request]);
        return;
      }
      const queue = this.queues.get(workspaceId) ?? [];
      queue.push(request);
      this.queues.set(workspaceId, queue);
    });
  }

  poll(workspaceId: string, waitMs: number, documentUrl?: string): Promise<WordToolRequest[]> {
    this.lastPollAt.set(workspaceId, Date.now());
    if (documentUrl !== undefined) {
      if (documentUrl) {
        this.lastDocumentUrl.set(workspaceId, documentUrl);
      } else {
        this.lastDocumentUrl.delete(workspaceId);
      }
    }

    const queue = this.queues.get(workspaceId) ?? [];
    if (queue.length > 0) {
      this.queues.set(workspaceId, []);
      return Promise.resolve(queue);
    }

    const wait = Math.min(Math.max(waitMs, 0), MAX_POLL_WAIT_MS);
    if (wait === 0) return Promise.resolve([]);

    return new Promise<WordToolRequest[]>((resolve) => {
      const waiter: PollWaiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(workspaceId) ?? [];
          this.waiters.set(
            workspaceId,
            list.filter((entry) => entry !== waiter),
          );
          // Liveness window keys off completed polls, not only new ones.
          this.lastPollAt.set(workspaceId, Date.now());
          resolve([]);
        }, wait),
      };
      const list = this.waiters.get(workspaceId) ?? [];
      list.push(waiter);
      this.waiters.set(workspaceId, list);
    });
  }

  complete(requestId: string, result: WordToolExecutionResult): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(result);
    return true;
  }
}
