import { OpenCode } from "@opencode/client";
import { join } from "node:path";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { inspectNativeEngineRecovery, assertNativeEngineRecoveryProjectsReady } from "./native-engine-recovery.js";
import { stopManagedOpencodeService, type ManagedOpencodeServiceOptions } from "./managed-opencode-service.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { migrateStoppedNativeSavedApprovals } from "./native-saved-approval-migration.js";
import { createManagedImageAffinity } from "./managed-image-affinity.js";
import { assertRegisteredLegacySessionPermissionsReady, restoreRegisteredLegacySessionPermissions } from "./session-history-permissions.js";
import type { ServerConfig } from "./types.js";
import { engineStorageDir } from "./engine-storage.js";
import { legacyMcpCredentialImportPending, migrateLegacyMcpCredentials } from "./legacy-mcp-credentials.js";
import { importLegacyProviderCredentials } from "./legacy-provider-credentials.js";

/** One engine at a time. Plain serve makes history readable while the global
 * native recovery sweep is held; only upstream service mode resumes old work. */
export async function startManagedEngineLifecycle(options: {
  config: ServerConfig;
  database: string;
  legacyMcpAuthPath?: string;
  service: ManagedOpencodeServiceOptions;
  create: (mode: "service" | "recovery", beforeSpawn?: () => Promise<void>) => Promise<ManagedOpencodeServer>;
}) {
  const { config } = options;
  const legacyMcpSource = options.legacyMcpAuthPath;
  const mcpReceipt = join(engineStorageDir(config), "credential-migration", "mcp-v1.json");
  let mcpImportPending = legacyMcpSource !== undefined && await legacyMcpCredentialImportPending(legacyMcpSource, mcpReceipt);
  const imageAffinity = await createManagedImageAffinity(config, options.database);
  let engine: ManagedOpencodeServer;
  let mode: "service" | "recovery" | "promoting" = "recovery";
  let failure: { code: string; message: string } | undefined;
  let admissions = 0, closed = false, serviceStartupFailed = false;
  let endpointLive = false, legacyPoliciesPrepared = false;
  const attempts = new Map<string, { kind: "oauth" | "command"; integrationID: string; attemptID: string; directory: string }>();
  let checking: Promise<void> | undefined;
  let catalogReload: Promise<boolean> | undefined;
  let catalogReloading = false;
  let events: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const prepareStoppedApprovals = async () => {
    if (endpointLive) throw new Error("Saved approval migration requires a stopped managed engine.");
    const migrated = await migrateStoppedNativeSavedApprovals(config, options.database);
    const workspace = config.workspaces[0];
    if (migrated.changed && workspace) await writeLegalworkRuntimeConfigFile(config, workspace.id);
  };
  const createStopped = (target: "service" | "recovery", check?: () => Promise<void>) => options.create(target, async () => {
    await prepareStoppedApprovals();
    await check?.();
  });
  await stopManagedOpencodeService(options.service);
  await prepareStoppedApprovals();
  const held = (await inspectNativeEngineRecovery(options.database)).sessions;
  const heldIDs = new Set(held.map(session => session.id));
  const prepareLegacyPolicies = async () => {
    await restoreRegisteredLegacySessionPermissions(config, client());
    await assertRegisteredLegacySessionPermissionsReady(config, client());
    legacyPoliciesPrepared = true;
  };
  const preflight = async () => {
    if (mcpImportPending && legacyMcpSource) {
      if (!endpointLive) throw new ApiError(409, "mcp_credential_import_pending", "Saved connector logins must be imported before interrupted work resumes.");
      await migrateLegacyMcpCredentials(client(), legacyMcpSource, mcpReceipt);
      mcpImportPending = false;
    }
    if (endpointLive) await prepareLegacyPolicies();
    else if (!legacyPoliciesPrepared) await assertRegisteredLegacySessionPermissionsReady(config);
    await assertNativeEngineRecoveryProjectsReady(config, options.database);
  };
  const publish = async () => {
    try {
      if (closed) throw new Error("Managed engine lifecycle closed during image history binding.");
      await imageAffinity.connect(engine);
      if (mcpImportPending && legacyMcpSource) {
        await migrateLegacyMcpCredentials(client(), legacyMcpSource, mcpReceipt);
        mcpImportPending = false;
      }
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
    endpointLive = true;
    // Session get/update is passive in the released API. Restore original chat
    // policies before service promotion can resume any interrupted agent work.
    try { await prepareLegacyPolicies(); } catch (error) { remember(error); }
  };
  const client = () => OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
  const remember = (error: unknown) => {
    failure = error instanceof ApiError ? { code: error.code, message: error.message } : { code: "engine_recovery_unresolved", message: error instanceof Error ? error.message : "Native recovery is unavailable." };
  };
  const authenticationIdle = async () => {
    for (const [key, attempt] of attempts) {
      const input = { integrationID: attempt.integrationID, attemptID: attempt.attemptID, location: { directory: attempt.directory } };
      const result = attempt.kind === "oauth" ? await client().integration.oauth.status(input) : await client().integration.command.status(input);
      if (result.data.status === "pending") return false;
      attempts.delete(key);
    }
    return true;
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
      if (closed || mode === "service" || mode === "promoting" || serviceStartupFailed && !explicit) return;
      if (!await authenticationIdle()) { scheduleIdleRetry(1000); return; }
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
      endpointLive = false;
      await engine.close();
      try { engine = await createStopped("service", preflight); await publish(); mode = "service"; serviceStartupFailed = false; failure = undefined; }
      catch (error) {
        remember(error); serviceStartupFailed = true;
        if (closed) return;
        engine = await createStopped("recovery"); await publish(); mode = "recovery"; monitor();
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
  const reloadCatalog = () => {
    if (catalogReload) return catalogReload;
    if (closed || mode !== "service" || checking || admissions > 0) return Promise.resolve(false);
    let reloaded = false;
    checking = (async () => {
      // Close admission before asynchronous idle checks. Existing sessions and
      // provider sign-ins finish in the current process; none are cancelled.
      catalogReloading = true;
      if (!await authenticationIdle() || Object.keys(await client().session.active()).length > 0
        || (await inspectNativeEngineRecovery(options.database)).sessions.length > 0) return;
      await preflight();
      if (closed) return;
      await client().location.reload();
      failure = undefined; reloaded = true;
    })().catch(error => { remember(error); }).finally(() => { catalogReloading = false; checking = undefined; });
    catalogReload = checking.then(() => reloaded).finally(() => { catalogReload = undefined; });
    return catalogReload;
  };
  let attemptedService = false;
  try { await preflight(); attemptedService = true; engine = await createStopped("service", preflight); mode = "service"; }
  catch (error) { remember(error); serviceStartupFailed = attemptedService; engine = await createStopped("recovery"); }
  await publish();
  config.managedImageAffinity = imageAffinity.resolve;
  config.managedEngineRecoveryState = () => ({ mode, heldSessions: mode === "service" ? [] : held, ...(failure ? { error: failure } : {}) });
  config.retryManagedEngineRecovery = refresh;
  config.reloadManagedEngineCatalog = reloadCatalog;
  config.withManagedEngineAdmission = async (sessionID, action) => {
    if (mode === "promoting" || catalogReloading) throw new ApiError(503, "engine_recovery_transition", catalogReloading
      ? "OpenCode is updating its model list. Retry this action when the update finishes."
      : "OpenCode is enabling native restart recovery. Retry this action when the engine reconnects.");
    if (mode === "recovery" && heldIDs.has(sessionID)) throw new ApiError(409, "engine_recovery_held", "This interrupted chat is preserved while native recovery waits for project approval or history resolution. Other approved projects can continue working.", failure);
    admissions++;
    try { return await action(); }
    finally { admissions--; }
  };
  config.observeManagedEngineResponse = async (request, response) => {
    if (!response.ok) return;
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
    reloadCatalog,
    async close() {
      closed = true; endpointLive = false; imageAffinity.disconnect(); delete config.managedImageAffinity; events?.abort(); if (retryTimer) clearTimeout(retryTimer);
      await checking; await engine.close();
      delete config.managedEngineRecoveryState; delete config.retryManagedEngineRecovery; delete config.reloadManagedEngineCatalog; delete config.withManagedEngineAdmission; delete config.observeManagedEngineResponse;
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
  config.managedEngineStatus = "starting";
  config.waitForManagedEngineEndpoint = () => endpoint;
  try {
    const engine = await createManagedOpencodeServer({ ...options, onAuthenticated(connection) {
      config.opencodeBaseUrl = connection.url; config.opencodeUsername = connection.username; config.opencodePassword = connection.password;
      for (const workspace of config.workspaces) { workspace.baseUrl = connection.url; workspace.opencodeUsername = connection.username; workspace.opencodePassword = connection.password; workspace.directory = workspace.path; }
      resolveEndpoint(); options.onAuthenticated?.(connection);
    }, onMigrationProgress(status) {
      config.managedEngineStatus = status.status === "running" ? "migrating" : "starting";
      options.onMigrationProgress?.(status);
    } });
    try {
      const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
      await importLegacyProviderCredentials(client, options);
      config.managedEngineStatus = "ready";
      return engine;
    } catch (error) { await engine.close(); throw error; }
  } catch (error) { config.managedEngineStatus = "error"; rejectEndpoint(error); throw error; }
  finally { config.managedEngineStarting = false; }
}
