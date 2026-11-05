import type { ApprovalConfig, ApprovalRequest, HostApprovalHandler } from "./types.js";
import { shortId } from "./utils.js";
import { createHash } from "node:crypto";
import type { RememberedApprovalStore } from "./remembered-approvals.js";
import { ApiError } from "./errors.js";

interface ApprovalResult {
  id: string;
  allowed: boolean;
  reason?: string;
}

interface PendingApproval {
  rememberHash?: string;
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  cleanup: () => void;
}

export class ApprovalService {
  private config: ApprovalConfig;
  private pending = new Map<string, PendingApproval>();
  private hostHandler?: HostApprovalHandler;
  private disposed = false;
  private remembered = new Map<string, string>();
  private failedRevocations = new Set<string | undefined>();

  constructor(config: ApprovalConfig, hostHandler?: HostApprovalHandler, private readonly onChange?: () => void,
    private readonly store?: RememberedApprovalStore) {
    this.config = config;
    this.hostHandler = hostHandler;
  }

  list(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((entry) => entry.request);
  }

  async requestApproval(
    input: Omit<ApprovalRequest, "id" | "createdAt">,
    signal?: AbortSignal,
    forceManual = false,
    rememberKey?: string,
  ): Promise<ApprovalResult> {
    if (this.disposed || signal?.aborted) {
      return { id: "cancelled", allowed: false, reason: "cancelled" };
    }
    const retryScope = this.failedRevocations.has(undefined) ? undefined : input.workspaceId;
    if (this.failedRevocations.has(retryScope)) {
      try { this.forgetRemembered(retryScope); }
      catch { return { id: "unavailable", allowed: false, reason: "approval_storage_unavailable" }; }
    }
    if (this.config.mode === "auto" && !forceManual) {
      return { id: "auto", allowed: true };
    }
    const rememberHash = rememberKey && input.sessionID
      ? createHash("sha256").update(JSON.stringify(["chat-approval-v1", input.workspaceId, input.sessionID, rememberKey])).digest("hex") : undefined;
    // Existing explicitly project-wide approvals retain their original scope.
    // New approvals are written only under the chat-specific key above.
    const legacyProjectHash = rememberHash ? createHash("sha256").update(JSON.stringify(["project-approval-v1", input.workspaceId, rememberKey])).digest("hex") : undefined;
    if ([rememberHash, legacyProjectHash].some(key => key && (this.store ? this.store.has(input.workspaceId, key) : this.remembered.has(key))))
      return { id: "remembered", allowed: true };
    const id = shortId();
    const request: ApprovalRequest = {
      ...input,
      canRemember: Boolean(rememberHash),
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
        rememberHash,
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
    this.onChange?.();

    const hostHandler = this.hostHandler;
    // Chat requests are answered in that chat's existing permission panel.
    // The host-only HTTP endpoint remains the authority for the decision.
    if (hostHandler && !request.sessionID) {
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

  respond(id: string, reply: "allow" | "deny" | "always"): ApprovalResult | null {
    const pending = this.pending.get(id);
    if (reply === "always") {
      if (!pending?.rememberHash || !pending.request.canRemember) return null;
      try { this.store?.remember(pending.request.workspaceId, pending.rememberHash); }
      catch { return this.settle(id, false, "approval_storage_unavailable"); }
      this.remembered.set(pending.rememberHash, pending.request.workspaceId);
    }
    return this.settle(id, reply !== "deny", reply === "deny" ? "denied" : undefined);
  }

  forgetRemembered(workspaceId?: string) {
    for (const [key, workspace] of this.remembered) if (!workspaceId || workspace === workspaceId) this.remembered.delete(key);
    try { this.store?.forget(workspaceId); }
    catch {
      this.failedRevocations.add(workspaceId);
      throw new ApiError(503, "approval_storage_unavailable", "Remembered access could not be revoked in LegalWork's approval storage. Running operations have been stopped. Retry when storage is available.");
    }
    if (workspaceId === undefined) this.failedRevocations.clear();
    else this.failedRevocations.delete(workspaceId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.remembered.clear();
    for (const id of this.pending.keys()) this.settle(id, false, "cancelled");
    this.store?.close();
  }

  private settle(id: string, allowed: boolean, reason?: string): ApprovalResult | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    this.onChange?.();
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
