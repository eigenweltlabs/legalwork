import { useEffect, useState } from "react";

import { readMcpStatuses } from "./native-mcp";
import type { Client } from "../../../app/types";
import { startRequestPolling } from "@/app/lib/request-poller";

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Live count of connected MCP servers for the active workspace, polled from
 * OpenCode's native MCP catalog. Used by the session status bar so it reflects real
 * connectivity instead of a hardcoded value.
 */
export function useMcpConnectedCount(client: Client | null, directory: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!client || !directory.trim()) {
      setCount(0);
      return;
    }

    let cancelled = false;
    const refresh = async (signal: AbortSignal) => {
      try {
        const status = await readMcpStatuses(client, directory, signal);
        if (cancelled) return;
        const values = Object.values(status);
        setCount(values.filter((entry) => entry.status === "connected").length);
      } catch (error) {
        if (!cancelled) setCount(0);
        throw error;
      }
    };

    const poller = startRequestPolling(refresh, { intervalMs: REFRESH_INTERVAL_MS });
    return () => {
      cancelled = true;
      poller.stop();
    };
  }, [client, directory]);

  return count;
}
