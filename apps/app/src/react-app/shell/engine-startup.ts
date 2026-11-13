import { useEffect, useRef, useState } from "react";
import { createLegalworkServerClient } from "../../app/lib/legalwork-server";
import { isDesktopRuntime } from "../../app/utils";
import { t } from "@/i18n";
import { useBootState } from "./boot-state";
import { resolveLegalworkConnection } from "./legalwork-connection";
import type { MigrationProgress, MigrationProgressResponse } from "@legalwork/types/migration-progress";

export type EngineStartupState =
  | { status: "starting" | "updating" | "ready"; progress?: MigrationProgress }
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
  onUpdating: (progress?: MigrationProgress) => void;
  migration?: () => Promise<MigrationProgressResponse>;
  signal: AbortSignal;
  pause?: typeof pauseStartupPoll;
}) {
  let failures = 0;
  let progressSupported = true;
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
    let progress: MigrationProgress | undefined;
    if (health.engine && options.migration && progressSupported) {
      try { progress = (await options.migration()).migration ?? undefined; }
      catch (error) {
        // Older servers keep their existing startup behavior. A temporary
        // progress-read failure must not hide a responsive migration.
        if (error instanceof Error && "status" in error && error.status === 404) progressSupported = false;
      }
      options.signal.throwIfAborted();
    }
    if (progress?.status === "error") throw new Error("Migration failed");
    // Servers without a managed engine have no migration to wait for.
    if (!health.engine || health.engine.status === "ready" && progress?.status !== "running") return;
    if (health.engine.status === "migrating" || progress?.status === "running") options.onUpdating(progress);
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
          await waitForEngineReady({ health: client.health, migration: client.migrationProgress, signal, onUpdating: (progress) => {
            setState(current => progress ? { status: "updating", progress } : current.status === "updating" ? current : { status: "updating" });
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
