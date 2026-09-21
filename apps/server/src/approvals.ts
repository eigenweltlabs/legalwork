import type { ApprovalConfig, ApprovalRequest, HostApprovalHandler } from "./types.js";
import { shortId } from "./utils.js";

interface ApprovalResult {
  id: string;
  allowed: boolean;
  reason?: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  cleanup: () => void;
}

export class ApprovalService {
  private config: ApprovalConfig;
  private pending = new Map<string, PendingApproval>();
  private hostHandler?: HostApprovalHandler;
  private disposed = false;

  constructor(config: ApprovalConfig, hostHandler?: HostApprovalHandler) {
    this.config = config;
    this.hostHandler = hostHandler;
  }

  list(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((entry) => entry.request);
  }

  async requestApproval(
    input: Omit<ApprovalRequest, "id" | "createdAt">,
    signal?: AbortSignal,
  ): Promise<ApprovalResult> {
    if (this.disposed || signal?.aborted) {
      return { id: "cancelled", allowed: false, reason: "cancelled" };
    }
    if (this.config.mode === "auto") {
      return { id: "auto", allowed: true };
    }
    const id = shortId();
    const request: ApprovalRequest = {
      ...input,
      id,
      createdAt: Date.now(),
    };

    const controller = new AbortController();
    const result = new Promise<ApprovalResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.settle(id, false, "timeout");
      }, this.config.timeoutMs);
      const cancel = () => { this.settle(id, false, "cancelled"); };
      this.pending.set(id, {
        request,
        resolve,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", cancel);
          controller.abort();
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
    });

    const hostHandler = this.hostHandler;
    if (hostHandler) {
      // Keep the pending request available to the host API while the native
      // confirmation is open. Either response closes the other presentation.
      void Promise.resolve().then(async () => {
        if (controller.signal.aborted) return;
        const reply = await hostHandler(request, controller.signal);
        this.respond(id, reply);
      }).catch(() => this.settle(id, false, "host_unavailable"));
    }
    return result;
  }

  respond(id: string, reply: "allow" | "deny"): ApprovalResult | null {
    return this.settle(id, reply === "allow", reply === "allow" ? undefined : "denied");
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.pending.keys()) this.settle(id, false, "cancelled");
  }

  private settle(id: string, allowed: boolean, reason?: string): ApprovalResult | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    pending.cleanup();
    const result: ApprovalResult = {
      id,
      allowed,
      reason,
    };
    pending.resolve(result);
    return result;
  }
}
