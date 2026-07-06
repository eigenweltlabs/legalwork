/**
 * Relay for tools that execute inside a connected Office task pane (Word,
 * Excel, PowerPoint).
 *
 * The agent (an OpenCode plugin) calls `execute`; the pane long-polls for
 * requests, runs them through Office.js, and posts results back. Mirrors the
 * ApprovalService pattern: pending requests live in memory and resolve when
 * the client answers or the timeout fires.
 *
 * Clients are keyed by (workspace, host): Word and Excel panes can be open
 * on the same workspace simultaneously, and a word_* request must never be
 * delivered to the Excel pane. Panes that predate host reporting register
 * under "unknown" and only receive requests when no host-specific pane
 * matches.
 */
import { shortId } from "./utils.js";

export type OfficeToolRequest = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
};

export type OfficeToolExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export type OfficePaneInfo = {
  host: string;
  documentUrl: string | null;
};

const UNKNOWN_HOST = "unknown";

const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;
const MAX_EXECUTE_TIMEOUT_MS = 120_000;
const MAX_POLL_WAIT_MS = 30_000;
/** A pane counts as connected if it polled within this window. */
const CLIENT_LIVENESS_MS = 40_000;

type PendingExecution = {
  request: OfficeToolRequest;
  clientKey: string;
  resolve: (result: OfficeToolExecutionResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PollWaiter = {
  resolve: (requests: OfficeToolRequest[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

function normalizeHost(host: string | undefined): string {
  const trimmed = host?.trim().toLowerCase();
  return trimmed || UNKNOWN_HOST;
}

/** Office host a tool belongs to, from its name prefix. */
export function hostForTool(tool: string): string {
  if (tool.startsWith("word_")) return "word";
  if (tool.startsWith("excel_")) return "excel";
  if (tool.startsWith("ppt_")) return "powerpoint";
  return UNKNOWN_HOST;
}

export class OfficeToolRelay {
  /** Requests not yet handed to a poller, per (workspace, host). */
  private queues = new Map<string, OfficeToolRequest[]>();
  /** All in-flight requests by id (queued or delivered), awaiting a result. */
  private pending = new Map<string, PendingExecution>();
  private waiters = new Map<string, PollWaiter[]>();
  private lastPollAt = new Map<string, number>();
  /** Open-document identity as last reported by each pane's polls. */
  private lastDocumentUrl = new Map<string, string>();
  /** Hosts that have ever polled a workspace (for status enumeration). */
  private knownHosts = new Map<string, Set<string>>();

  private clientKey(workspaceId: string, host: string): string {
    return `${workspaceId} ${host}`;
  }

  private keyConnected(key: string): boolean {
    if ((this.waiters.get(key)?.length ?? 0) > 0) return true;
    const last = this.lastPollAt.get(key) ?? 0;
    return Date.now() - last < CLIENT_LIVENESS_MS;
  }

  /**
   * Client key a tool for `host` should be routed to: the host-specific pane
   * when connected, else a legacy "unknown" pane. Null when nothing suitable
   * is connected.
   */
  private routeKey(workspaceId: string, host: string): string | null {
    const specific = this.clientKey(workspaceId, host);
    if (this.keyConnected(specific)) return specific;
    if (host !== UNKNOWN_HOST) {
      const legacy = this.clientKey(workspaceId, UNKNOWN_HOST);
      if (this.keyConnected(legacy)) return legacy;
    }
    return null;
  }

  /** True when any pane (optionally: one usable for `host`) is connected. */
  clientConnected(workspaceId: string, host?: string): boolean {
    if (host) return this.routeKey(workspaceId, normalizeHost(host)) !== null;
    return this.connectedPanes(workspaceId).length > 0;
  }

  /** All currently connected panes for a workspace with their documents. */
  connectedPanes(workspaceId: string): OfficePaneInfo[] {
    const hosts = this.knownHosts.get(workspaceId) ?? new Set<string>();
    const panes: OfficePaneInfo[] = [];
    for (const host of hosts) {
      const key = this.clientKey(workspaceId, host);
      if (!this.keyConnected(key)) continue;
      panes.push({ host, documentUrl: this.lastDocumentUrl.get(key) ?? null });
    }
    return panes;
  }

  execute(
    workspaceId: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<OfficeToolExecutionResult> {
    const host = hostForTool(tool);
    const key = this.routeKey(workspaceId, host);
    if (!key) {
      const label = host === UNKNOWN_HOST ? "Word, Excel, or PowerPoint" : host.charAt(0).toUpperCase() + host.slice(1);
      return Promise.resolve({
        ok: false,
        error: `No matching Office pane is connected for this workspace. Ask the user to open the LegalWork pane in Microsoft ${label}.`,
      });
    }

    const request: OfficeToolRequest = {
      id: shortId(),
      tool,
      args,
      createdAt: Date.now(),
    };
    const timeout = Math.min(
      Math.max(timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS, 1_000),
      MAX_EXECUTE_TIMEOUT_MS,
    );

    return new Promise<OfficeToolExecutionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const queue = this.queues.get(key);
        if (queue) {
          this.queues.set(
            key,
            queue.filter((entry) => entry.id !== request.id),
          );
        }
        resolve({
          ok: false,
          error: `The Office pane did not answer within ${Math.round(timeout / 1000)}s. The document may be busy or the pane was closed.`,
        });
      }, timeout);
      this.pending.set(request.id, { request, clientKey: key, resolve, timer });

      const waiter = this.waiters.get(key)?.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve([request]);
        return;
      }
      const queue = this.queues.get(key) ?? [];
      queue.push(request);
      this.queues.set(key, queue);
    });
  }

  poll(
    workspaceId: string,
    waitMs: number,
    documentUrl?: string,
    host?: string,
  ): Promise<OfficeToolRequest[]> {
    const normalizedHost = normalizeHost(host);
    const key = this.clientKey(workspaceId, normalizedHost);
    this.lastPollAt.set(key, Date.now());
    const hosts = this.knownHosts.get(workspaceId) ?? new Set<string>();
    hosts.add(normalizedHost);
    this.knownHosts.set(workspaceId, hosts);
    if (documentUrl !== undefined) {
      if (documentUrl) {
        this.lastDocumentUrl.set(key, documentUrl);
      } else {
        this.lastDocumentUrl.delete(key);
      }
    }

    const queue = this.queues.get(key) ?? [];
    if (queue.length > 0) {
      this.queues.set(key, []);
      return Promise.resolve(queue);
    }

    const wait = Math.min(Math.max(waitMs, 0), MAX_POLL_WAIT_MS);
    if (wait === 0) return Promise.resolve([]);

    return new Promise<OfficeToolRequest[]>((resolve) => {
      const waiter: PollWaiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(key) ?? [];
          this.waiters.set(
            key,
            list.filter((entry) => entry !== waiter),
          );
          // Liveness window keys off completed polls, not only new ones.
          this.lastPollAt.set(key, Date.now());
          resolve([]);
        }, wait),
      };
      const list = this.waiters.get(key) ?? [];
      list.push(waiter);
      this.waiters.set(key, list);
    });
  }

  complete(requestId: string, result: OfficeToolExecutionResult): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(result);
    return true;
  }
}
