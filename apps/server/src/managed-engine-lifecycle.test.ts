import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the controlled dependency bindings in a separate process so the normal
// server and released-engine suites always import their real implementations.
for (const scenario of ["publish", "rollback", "close"]) {
  test(`managed lifecycle keeps admission closed until ${scenario} binding settles`, async () => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-lifecycle-publish-")), script = join(root, "control.mjs");
    await writeFile(script, `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      const scenario = ${JSON.stringify(scenario)};
      const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
      const serviceStarted = deferred(), serviceRelease = deferred(), rollbackStarted = deferred(), rollbackRelease = deferred();
      let allowed = false, affinity, created = [], bindingCalls = 0;
      mock.module(${JSON.stringify(new URL("./managed-image-affinity.ts", import.meta.url).href)}, () => ({
        createManagedImageAffinity: async () => ({
          async connect(engine) {
            const call = ++bindingCalls;
            if (call === 2) { serviceStarted.resolve(); await serviceRelease.promise; }
            if (call === 3) { rollbackStarted.resolve(); await rollbackRelease.promise; }
            affinity = { storageNamespace: "synthetic-owned-history", connectionGeneration: {} };
          },
          disconnect() { affinity = undefined; },
          resolve() { return affinity; },
        }),
      }));
      mock.module(${JSON.stringify(new URL("./native-engine-recovery.ts", import.meta.url).href)}, () => ({
        inspectNativeEngineRecovery: async () => ({ sessions: [{ id: "held" }] }),
        assertNativeEngineRecoveryProjectsReady: async () => { if (!allowed) throw new Error("Project approval held"); },
      }));
      mock.module(${JSON.stringify(new URL("./session-history-permissions.ts", import.meta.url).href)}, () => ({ assertRegisteredLegacySessionPermissionsReady: async () => {}, restoreRegisteredLegacySessionPermissions: async () => {} }));
      mock.module(${JSON.stringify(new URL("./legalwork-runtime-config.ts", import.meta.url).href)}, () => ({ writeLegalworkRuntimeConfigFile: async () => "synthetic-config" }));
      mock.module(${JSON.stringify(new URL("./native-saved-approval-migration.ts", import.meta.url).href)}, () => ({ migrateStoppedNativeSavedApprovals: async () => ({ changed: false }) }));
      mock.module(${JSON.stringify(new URL("./managed-opencode-service.ts", import.meta.url).href)}, () => ({ stopManagedOpencodeService: async () => {} }));
      mock.module(${JSON.stringify(new URL("./managed-opencode.ts", import.meta.url).href)}, () => ({ createManagedOpencodeServer: async () => { throw new Error("Unexpected engine factory; use the owned injected creator"); } }));
      mock.module(${JSON.stringify(import.meta.resolve("@opencode/client"))}, () => ({ OpenCode: { make: () => ({
        session: { active: async () => ({}) },
        event: { async *subscribe({ signal }) { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); }); } },
      }) } }));
      const { startManagedEngineLifecycle } = await import(${JSON.stringify(new URL("./managed-engine-lifecycle.ts", import.meta.url).href)});
      const workspace = { id: "project", path: ${JSON.stringify(root)}, name: "Project", preset: "starter", workspaceType: "local" };
      const config = { workspaces: [workspace] };
      const lifecycle = await startManagedEngineLifecycle({ config, database: "synthetic-no-database", service: {}, create: async mode => {
        const entry = { mode, url: "http://127.0.0.1:" + (32100 + created.length), username: "synthetic", password: "synthetic", closed: false, async close() { this.closed = true; } };
        created.push(entry); return entry;
      } });
      const originalURL = config.opencodeBaseUrl, originalAffinity = config.managedImageAffinity(workspace);
      assert.equal(config.managedEngineRecoveryState().mode, "recovery");
      allowed = true;
      const promotion = lifecycle.refresh();
      let closing;
      try {
        await serviceStarted.promise;
        assert.equal(config.managedEngineRecoveryState().mode, "promoting", "binding pending must not advertise service ready");
        assert.equal(config.opencodeBaseUrl, originalURL);
        assert.equal(config.managedImageAffinity(workspace), undefined);
        let admitted = false;
        await assert.rejects(config.withManagedEngineAdmission("new", async () => { admitted = true; }), error => error.code === "engine_recovery_transition");
        assert.equal(admitted, false);
        if (scenario === "close") {
          closing = lifecycle.close(); serviceRelease.resolve();
          await promotion; await closing;
          assert.equal(config.opencodeBaseUrl, originalURL, "late binding must not publish a closed owner");
          assert.equal(config.managedImageAffinity, undefined);
          assert(created.every(engine => engine.closed));
        } else if (scenario === "rollback") {
          serviceRelease.reject(new Error("Synthetic binding failure"));
          await rollbackStarted.promise;
          assert.equal(config.managedEngineRecoveryState().mode, "promoting", "recovery fallback is not ready before its own binding");
          assert.equal(config.opencodeBaseUrl, originalURL);
          assert.equal(config.managedImageAffinity(workspace), undefined);
          await assert.rejects(config.withManagedEngineAdmission("new", async () => {}), error => error.code === "engine_recovery_transition");
          assert.equal(created[1].closed, true);
          rollbackRelease.resolve(); await promotion;
          assert.equal(config.managedEngineRecoveryState().mode, "recovery");
          assert.match(config.managedEngineRecoveryState().error.message, /Synthetic binding failure/);
          assert.equal(config.opencodeBaseUrl, created[2].url);
          assert.equal(config.managedImageAffinity(workspace).storageNamespace, originalAffinity.storageNamespace);
          await assert.rejects(config.withManagedEngineAdmission("held", async () => {}), error => error.code === "engine_recovery_held");
          await config.withManagedEngineAdmission("new", async () => { admitted = true; });
          assert.equal(admitted, true);
        } else {
          serviceRelease.resolve(); await promotion;
          assert.equal(config.managedEngineRecoveryState().mode, "service");
          assert.equal(config.opencodeBaseUrl, created[1].url);
          assert.equal(workspace.baseUrl, created[1].url);
          assert.notEqual(config.managedImageAffinity(workspace), originalAffinity);
          assert.equal(config.managedImageAffinity(workspace).storageNamespace, originalAffinity.storageNamespace);
          await config.withManagedEngineAdmission("held", async () => { admitted = true; });
          assert.equal(admitted, true);
        }
      } finally {
        serviceRelease.resolve(); rollbackRelease.resolve();
        await promotion; await (closing ?? lifecycle.close());
      }
      console.log("completed controlled lifecycle " + scenario);
    `);
    try {
      const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exit, stderr: exit === 0 ? "" : stderr, stdout }).toEqual({ exit: 0, stderr: "", stdout: `completed controlled lifecycle ${scenario}\n` });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("catalog reload defers active sessions, admission and service-mode sign-ins without replacing the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-lifecycle-catalog-")), script = join(root, "control.mjs");
  await writeFile(script, `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
    let active = {}, authStatus = "pending", authReads = 0, affinity, created = [], reloads = 0, failReload = false;
    const reloadStarted = deferred(), reloadRelease = deferred();
    mock.module(${JSON.stringify(new URL("./managed-image-affinity.ts", import.meta.url).href)}, () => ({ createManagedImageAffinity: async () => ({
      async connect() { affinity = { storageNamespace: "same-owned-history", connectionGeneration: {} }; },
      disconnect() { affinity = undefined; }, resolve() { return affinity; },
    }) }));
    mock.module(${JSON.stringify(new URL("./native-engine-recovery.ts", import.meta.url).href)}, () => ({ inspectNativeEngineRecovery: async () => ({ sessions: [] }), assertNativeEngineRecoveryProjectsReady: async () => {} }));
    mock.module(${JSON.stringify(new URL("./session-history-permissions.ts", import.meta.url).href)}, () => ({ assertRegisteredLegacySessionPermissionsReady: async () => {}, restoreRegisteredLegacySessionPermissions: async () => {} }));
    mock.module(${JSON.stringify(new URL("./legalwork-runtime-config.ts", import.meta.url).href)}, () => ({ writeLegalworkRuntimeConfigFile: async () => "synthetic-config" }));
    mock.module(${JSON.stringify(new URL("./native-saved-approval-migration.ts", import.meta.url).href)}, () => ({ migrateStoppedNativeSavedApprovals: async () => ({ changed: false }) }));
    mock.module(${JSON.stringify(new URL("./managed-opencode-service.ts", import.meta.url).href)}, () => ({ stopManagedOpencodeService: async () => {} }));
    mock.module(${JSON.stringify(new URL("./managed-opencode.ts", import.meta.url).href)}, () => ({ createManagedOpencodeServer: async () => { throw new Error("Use injected owned creator"); } }));
    mock.module(${JSON.stringify(import.meta.resolve("@opencode/client"))}, () => ({ OpenCode: { make: () => ({
      location: { reload: async () => { if (failReload) throw new Error("Synthetic native catalog reload failure"); reloads++; reloadStarted.resolve(); await reloadRelease.promise; } },
      session: { active: async () => active }, integration: { oauth: { status: async () => { authReads++; return { data: { status: authStatus } }; } }, command: { status: async () => { authReads++; return { data: { status: authStatus } }; } } },
      event: { async *subscribe({ signal }) { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); }); } },
    }) } }));
    const { startManagedEngineLifecycle } = await import(${JSON.stringify(new URL("./managed-engine-lifecycle.ts", import.meta.url).href)});
    const workspace = { id: "project", path: ${JSON.stringify(root)}, name: "Project", preset: "starter", workspaceType: "local" }, config = { workspaces: [workspace] };
    const lifecycle = await startManagedEngineLifecycle({ config, database: "synthetic", service: {}, create: async mode => {
      assert.equal(created.filter(entry => !entry.closed).length, 0, "previous child must close before replacement starts");
      const child = { mode, url: "http://127.0.0.1:" + (32500 + created.length), username: "synthetic", password: "synthetic", closed: false, async close() { this.closed = true; } };
      created.push(child); return child;
    } });
    try {
      assert.equal(config.managedEngineRecoveryState().mode, "service");
      active = { working: { type: "running" } };
      assert.equal(await config.reloadManagedEngineCatalog(), false);
      active = {};
      const admissionRelease = deferred();
      const admitted = config.withManagedEngineAdmission("working", async () => { await admissionRelease.promise; return new Response(); });
      assert.equal(await config.reloadManagedEngineCatalog(), false);
      admissionRelease.resolve(); await admitted;
      for (const kind of ["oauth", "command"]) {
        authStatus = "pending";
        await config.observeManagedEngineResponse({ method: "POST", path: "/api/integration/fixture/connect/" + kind, directory: workspace.path }, Response.json({ data: { attemptID: kind } }));
        assert.equal(await config.reloadManagedEngineCatalog(), false, kind + " sign-in must stay in its original process");
        assert.equal(created.length, 1);
        authStatus = "completed";
        await config.observeManagedEngineResponse({ method: "POST", path: "/api/integration/fixture/connect/" + kind + "/" + kind + "/complete", directory: workspace.path }, Response.json({}));
      }
      await config.observeManagedEngineResponse({ method: "POST", path: "/api/integration/fixture/connect/oauth", directory: workspace.path }, Response.json({ data: { attemptID: "completed" } }));
      const oldURL = config.opencodeBaseUrl, oldAffinity = config.managedImageAffinity(workspace);
      const first = config.reloadManagedEngineCatalog(), second = config.reloadManagedEngineCatalog();
      assert.equal(first, second, "concurrent catalog requests coalesce");
      await reloadStarted.promise;
      assert.equal(created.length, 1);
      assert.equal(created[0].closed, false);
      assert.equal(config.opencodeBaseUrl, oldURL);
      assert.equal(config.managedImageAffinity(workspace), oldAffinity);
      await assert.rejects(config.withManagedEngineAdmission("new", async () => new Response()), error => error.code === "engine_recovery_transition");
      reloadRelease.resolve();
      assert.equal(await first, true); assert.equal(await second, true);
      assert.equal(config.managedEngineRecoveryState().mode, "service");
      assert.equal(workspace.baseUrl, created[0].url);
      assert.equal(config.managedImageAffinity(workspace).storageNamespace, oldAffinity.storageNamespace);
      assert(authReads >= 3, "service-mode sign-ins must be checked");
      assert.equal(reloads, 1);
      failReload = true;
      assert.equal(await config.reloadManagedEngineCatalog(), false);
      assert.equal(config.managedEngineRecoveryState().mode, "service");
      assert.match(config.managedEngineRecoveryState().error.message, /Synthetic native catalog reload failure/);
      assert.equal(created.length, 1);
      assert.equal(created[0].closed, false);
      await config.withManagedEngineAdmission("new", async () => new Response());
    } finally { reloadRelease.resolve(); await lifecycle.close(); }
    assert(created.every(child => child.closed));
    assert.equal(config.reloadManagedEngineCatalog, undefined);
    console.log("completed controlled catalog reload");
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr: exit === 0 ? "" : stderr, stdout }).toEqual({ exit: 0, stderr: "", stdout: "completed controlled catalog reload\n" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
