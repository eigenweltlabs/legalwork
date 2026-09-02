export const LEGALMEMORY_CONNECTION_CHANGED_EVENT = "legalwork:legalmemory-connection-changed";

const LEGALMEMORY_MCP_NAME = /^(?:legal[_-]?memory|knowledge[_-]?index)$/i;

export function isLegalMemoryMcpName(name: string): boolean {
  return LEGALMEMORY_MCP_NAME.test(name.trim());
}

export function notifyLegalMemoryConnectionChanged(name: string): void {
  if (!isLegalMemoryMcpName(name) || typeof window === "undefined") return;
  window.dispatchEvent(new Event(LEGALMEMORY_CONNECTION_CHANGED_EVENT));
}
