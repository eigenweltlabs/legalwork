import { useEffect, useRef, useState } from "react";
import { createLegalworkServerClient } from "../../app/lib/legalwork-server";
import { isDesktopRuntime } from "../../app/utils";
import { t } from "@/i18n";
import { useBootState } from "./boot-state";
import { resolveLegalworkConnection } from "./legalwork-connection";

export type EngineStartupState =
  | { status: "starting" | "updating" | "ready" }
  | { status: "error"; message: string };

type EngineHealth = { engine?: { status: "starting" | "migrating" | "ready" | "error" } };

export function pauseStartupPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A responsive migration has no deadline. Only failed health requests exhaust retries. */
export async function waitForEngineReady(options: {
  health: () => Promise<EngineHealth>;
  onUpdating: () => void;
  signal: AbortSignal;
  pause?: typeof pauseStartupPoll;
}) {
  let failures = 0;
  while (true) {
    options.signal.throwIfAborted();
    let health: EngineHealth;
    try { health = await options.health(); failures = 0; }
    catch (error) {
      if (++failures >= 3) throw error;
      await (options.pause ?? pauseStartupPoll)(options.signal);
      continue;
    }
    options.signal.throwIfAborted();
    if (health.engine?.status === "error") throw new Error("Engine startup failed");
    // Servers without a managed engine have no migration to wait for.
    if (!health.engine || health.engine.status === "ready") return;
    if (health.engine.status === "migrating") options.onUpdating();
    await (options.pause ?? pauseStartupPoll)(options.signal);
  }
}

/** Keep routes and their project requests unmounted until history is available. */
export function useEngineStartup(): EngineStartupState {
  const { phase } = useBootState();
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [state, setState] = useState<EngineStartupState>({ status: "starting" });
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let updating = false;
    void (async () => {
      while (true) {
        signal.throwIfAborted();
        const connection = await resolveLegalworkConnection();
        signal.throwIfAborted();
        if (connection.normalizedBaseUrl && connection.resolvedToken) {
          const client = createLegalworkServerClient({
            baseUrl: connection.normalizedBaseUrl,
            token: connection.resolvedToken,
            hostToken: connection.resolvedHostToken || undefined,
          });
          await waitForEngineReady({ health: client.health, signal, onUpdating: () => {
            if (!updating) setState({ status: "updating" });
            updating = true;
          } });
          break;
        }
        // Allow first-run setup and web clients with no configured server.
        if (!isDesktopRuntime() || phaseRef.current === "ready") break;
        if (phaseRef.current === "error") return;
        await pauseStartupPoll(signal);
      }
      if (!signal.aborted) setState({ status: "ready" });
    })().catch(() => {
      if (!signal.aborted) setState({ status: "error", message: t(updating ? "boot.update_failed" : "desktop.runtime_start_failed") });
    });
    return () => controller.abort();
  }, []);
  return state;
}
