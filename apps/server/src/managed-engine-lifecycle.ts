import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { inspectNativeEngineRecovery, assertNativeEngineRecoveryProjectsReady } from "./native-engine-recovery.js";
import { stopManagedOpencodeService, type ManagedOpencodeServiceOptions } from "./managed-opencode-service.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { createManagedImageAffinity } from "./managed-image-affinity.js";
import type { ServerConfig } from "./types.js";

/** One engine at a time. Plain serve makes history readable while the global
 * native recovery sweep is held; only upstream service mode resumes old work. */
export async function startManagedEngineLifecycle(options: {
  config: ServerConfig;
  database: string;
  service: ManagedOpencodeServiceOptions;
  create: (mode: "service" | "recovery", beforeSpawn?: () => Promise<void>) => Promise<ManagedOpencodeServer>;
}) {
  const { config } = options;
  const imageAffinity = await createManagedImageAffinity(config, options.database);
  let engine: ManagedOpencodeServer;
  let mode: "service" | "recovery" | "promoting" = "recovery";
  let failure: { code: string; message: string } | undefined;
  let admissions = 0, closed = false, serviceStartupFailed = false;
  const attempts = new Map<string, { kind: "oauth" | "command"; integrationID: string; attemptID: string; directory: string }>();
  let checking: Promise<void> | undefined;
  let events: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  await stopManagedOpencodeService(options.service);
  const held = (await inspectNativeEngineRecovery(options.database)).sessions;
  const heldIDs = new Set(held.map(session => session.id));
  const preflight = async () => { await assertNativeEngineRecoveryProjectsReady(config, options.database); };
  const publish = async () => {
    try {
      if (closed) throw new Error("Managed engine lifecycle closed during image history binding.");
      await imageAffinity.connect(engine);
      if (closed) throw new Error("Managed engine lifecycle closed during image history binding.");
    } catch (error) {
      imageAffinity.disconnect();
      await engine.close();
      throw error;
    }
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    for (const workspace of config.workspaces) {
      workspace.baseUrl = engine.url; workspace.opencodeUsername = engine.username; workspace.opencodePassword = engine.password;
      workspace.directory = workspace.path;
    }
  };
  const client = () => OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
  const remember = (error: unknown) => {
    failure = error instanceof ApiError ? { code: error.code, message: error.message } : { code: "engine_recovery_unresolved", message: error instanceof Error ? error.message : "Native recovery is unavailable." };
  };
  const scheduleIdleRetry = (delay = 250) => {
    if (retryTimer || closed || mode !== "recovery") return;
    // Readiness polling only while currently running work prevents promotion;
    // this is neither a model task deadline nor automatic message replay.
    retryTimer = setTimeout(() => { retryTimer = undefined; void refresh(false); }, delay);
    retryTimer.unref?.();
  };
  const refresh = (explicit = true) => {
    checking ??= (async () => {
      if (closed || mode === "service" || serviceStartupFailed && !explicit) return;
      for (const [key, attempt] of attempts) {
        const input = { integrationID: attempt.integrationID, attemptID: attempt.attemptID, location: { directory: attempt.directory } };
        const result = attempt.kind === "oauth" ? await client().integration.oauth.status(input) : await client().integration.command.status(input);
        if (result.data.status === "pending") { scheduleIdleRetry(1000); return; }
        attempts.delete(key);
      }
      if (admissions > 0 || Object.keys(await client().session.active()).length > 0) { failure = undefined; scheduleIdleRetry(); return; }
      const current = await inspectNativeEngineRecovery(options.database);
      // Old held notifications require service recovery. Newly admitted jobs
      // must finish in the current process rather than being interrupted.
      if (current.sessions.some(session => !heldIDs.has(session.id))) { scheduleIdleRetry(); return; }
      try { await preflight(); failure = undefined; }
      catch (error) { remember(error); return; }
      mode = "promoting";
      if (admissions > 0) { mode = "recovery"; scheduleIdleRetry(); return; }
      events?.abort(); events = undefined;
      imageAffinity.disconnect();
      await engine.close();
      try { engine = await options.create("service", preflight); await publish(); mode = "service"; serviceStartupFailed = false; failure = undefined; }
      catch (error) {
        remember(error); serviceStartupFailed = true;
        if (closed) return;
        engine = await options.create("recovery"); await publish(); mode = "recovery"; monitor();
      }
    })().catch(error => { remember(error); }).finally(() => { checking = undefined; });
    return checking;
  };
  const monitor = () => {
    const controller = new AbortController(); events = controller;
    void (async () => {
      let backoff = 100;
      while (!controller.signal.aborted && !closed) {
        try {
          for await (const event of client().event.subscribe({ signal: controller.signal })) {
            backoff = 100;
            if (event.type === "server.connected" || event.type === "session.idle" || event.type.startsWith("session.execution.") || event.type === "session.tool.success" || event.type === "session.tool.failed") void refresh(false);
          }
        } catch { if (controller.signal.aborted) break; }
        if (controller.signal.aborted || closed) break;
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, backoff); controller.signal.addEventListener("abort", finish, { once: true });
        });
        backoff = Math.min(backoff * 2, 2000);
      }
    })();
  };
  let attemptedService = false;
  try { await preflight(); attemptedService = true; engine = await options.create("service", preflight); mode = "service"; }
  catch (error) { remember(error); serviceStartupFailed = attemptedService; engine = await options.create("recovery"); }
  await publish();
  config.managedImageAffinity = imageAffinity.resolve;
  config.managedEngineRecoveryState = () => ({ mode, heldSessions: mode === "service" ? [] : held, ...(failure ? { error: failure } : {}) });
  config.retryManagedEngineRecovery = refresh;
  config.withManagedEngineAdmission = async (sessionID, action) => {
    if (mode === "promoting") throw new ApiError(503, "engine_recovery_transition", "OpenCode is enabling native restart recovery. Retry this action when the engine reconnects.");
    if (mode === "recovery" && heldIDs.has(sessionID)) throw new ApiError(409, "engine_recovery_held", "This interrupted chat is preserved while native recovery waits for project approval or history resolution. Other approved projects can continue working.", failure);
    admissions++;
    try { return await action(); }
    finally { admissions--; }
  };
  config.observeManagedEngineResponse = async (request, response) => {
    if (mode === "service" || !response.ok) return;
    const match = request.path.match(/^\/api\/integration\/([^/]+)\/connect\/(oauth|command)(?:\/([^/]+)(?:\/(complete))?)?$/);
    if (!match) return;
    const integrationID = decodeURIComponent(match[1] ?? ""), kind = match[2] === "oauth" ? "oauth" : "command";
    const attemptID = match[3] ? decodeURIComponent(match[3]) : undefined;
    if (attemptID && (request.method === "DELETE" || match[4])) { attempts.delete(`${integrationID}:${attemptID}`); void refresh(false); return; }
    if (request.method !== "POST" || attemptID) return;
    const parsed = z.object({ data: z.object({ attemptID: z.string() }) }).safeParse(await response.clone().json().catch(() => undefined));
    if (!parsed.success) throw new ApiError(502, "engine_auth_attempt_invalid", "OpenCode returned an invalid connection attempt; native recovery remains held.");
    const id = parsed.data.data.attemptID;
    attempts.set(`${integrationID}:${id}`, { kind, integrationID, attemptID: id, directory: request.directory });
  };
  if (mode === "recovery") monitor();
  return {
    get engine() { return engine; },
    refresh,
    async close() {
      closed = true; imageAffinity.disconnect(); delete config.managedImageAffinity; events?.abort(); if (retryTimer) clearTimeout(retryTimer);
      await checking; await engine.close();
      delete config.managedEngineRecoveryState; delete config.retryManagedEngineRecovery; delete config.withManagedEngineAdmission; delete config.observeManagedEngineResponse;
    },
  };
}


/** Bootstrap requests can wait for a verified endpoint without accepting a
 * guessed port. History remains unavailable until upstream migration finishes. */
export async function createConfiguredManagedEngine(config: ServerConfig, options: Parameters<typeof createManagedOpencodeServer>[0]) {
  let resolveEndpoint: () => void = () => {}, rejectEndpoint: (error: unknown) => void = () => {};
  const endpoint = new Promise<void>((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
  void endpoint.catch(() => {});
  config.managedEngineStarting = true;
  config.waitForManagedEngineEndpoint = () => endpoint;
  try {
    return await createManagedOpencodeServer({ ...options, onAuthenticated(connection) {
      config.opencodeBaseUrl = connection.url; config.opencodeUsername = connection.username; config.opencodePassword = connection.password;
      for (const workspace of config.workspaces) { workspace.baseUrl = connection.url; workspace.opencodeUsername = connection.username; workspace.opencodePassword = connection.password; workspace.directory = workspace.path; }
      resolveEndpoint(); options.onAuthenticated?.(connection);
    } });
  } catch (error) { rejectEndpoint(error); throw error; }
  finally { config.managedEngineStarting = false; }
}
