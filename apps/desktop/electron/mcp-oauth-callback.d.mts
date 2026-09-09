import type { EventEmitter } from "node:events";

export const MCP_OAUTH_REDIRECT_URI: string;
export function watchMcpOAuthOwner(
  contents: Pick<EventEmitter, "on"> & { id: number },
  broker: { cancelOwner(owner: number): void },
): void;
export function createMcpOAuthCallbackBroker(options?: { timeoutMs?: number }): {
  listen(options?: { redirectUri?: string }, owner?: number): Promise<{ listenerId: string; redirectUri: string }>;
  wait(options: { listenerId: string; state: string }, owner?: number): Promise<{ code: string }>;
  cancel(listenerId: string, owner?: number): void;
  cancelOwner(owner: number): void;
  close(): void;
};
