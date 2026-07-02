/** @jsxImportSource react */
import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";

import { readLegalworkServerSettings } from "@/app/lib/legalwork-server";
import { getDocumentUrl, isWordDocumentHost, officeHostName } from "./office";
import { isExcelWorkbookHost } from "./excel-api";
import { createExcelToolHandlers } from "./excel-document-tools";
import { isPowerPointHost } from "./powerpoint-api";
import { createPowerPointToolHandlers } from "./powerpoint-document-tools";
import { createWordToolHandlers } from "./word-document-tools";

/**
 * Connects the pane to the server's word-tool relay: long-polls for tool
 * requests issued by the agent, executes them through Office.js, and posts
 * the results back. Mounted once in the pane root; active only inside Word
 * and only while a workspace is selected (the relay is workspace-scoped).
 */

const POLL_WAIT_SECONDS = 25;
const RETRY_DELAY_MS = 3_000;

function workspaceIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/(?:w|workspace)\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

type RelayRequest = { id: string; tool: string; args?: Record<string, unknown> };

async function runRelayLoop(workspaceId: string, signal: AbortSignal): Promise<void> {
  const settings = readLegalworkServerSettings();
  const baseUrl = settings.urlOverride ?? window.location.origin;
  const token = settings.token ?? "";
  const host = officeHostName() ?? "";
  const handlers = isExcelWorkbookHost()
    ? createExcelToolHandlers()
    : isPowerPointHost()
      ? createPowerPointToolHandlers()
      : createWordToolHandlers();
  const relayBase = `${baseUrl}/workspace/${encodeURIComponent(workspaceId)}/office-tools`;
  const authHeaders = { Authorization: `Bearer ${token}` };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        resolve();
      });
    });

  while (!signal.aborted) {
    try {
      // Report the open document and host with every poll so the agent's
      // system prompt can name them (and notice save-as / doc switches).
      const documentParam = encodeURIComponent(getDocumentUrl() ?? "");
      const response = await fetch(
        `${relayBase}/poll?wait=${POLL_WAIT_SECONDS}&document=${documentParam}&host=${encodeURIComponent(host)}`,
        {
          headers: authHeaders,
          signal,
        },
      );
      if (!response.ok) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const payload = (await response.json()) as { requests?: RelayRequest[] };
      for (const request of payload.requests ?? []) {
        if (signal.aborted) return;
        let result: { ok: true; result: unknown } | { ok: false; error: string };
        try {
          const handler = handlers[request.tool];
          if (!handler) {
            result = {
              ok: false,
              error: `Tool ${request.tool} is not available in this Office host (${host || "unknown"}).`,
            };
          } else {
            result = { ok: true, result: await handler(request.args ?? {}) };
          }
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        await fetch(`${relayBase}/requests/${encodeURIComponent(request.id)}/result`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(result),
          signal,
        });
      }
    } catch {
      if (signal.aborted) return;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

export function WordToolRelayHost() {
  const location = useLocation();
  const workspaceId = useMemo(() => workspaceIdFromPath(location.pathname), [location.pathname]);

  useEffect(() => {
    if (!workspaceId) return;
    if (!isWordDocumentHost() && !isExcelWorkbookHost() && !isPowerPointHost()) return;
    const controller = new AbortController();
    void runRelayLoop(workspaceId, controller.signal);
    return () => controller.abort();
  }, [workspaceId]);

  return null;
}
