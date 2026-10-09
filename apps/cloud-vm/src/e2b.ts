import { Sandbox } from "e2b";
import type { Runtime } from "./lifecycle.js";
import type { Worker } from "./store.js";

export class E2BRuntime implements Runtime {
  private sandboxes = new Map<string, Sandbox>();
  private timeoutMs = 3_600_000;
  constructor(private options: { apiKey: string; apiUrl: string; sandboxUrl: string }) {}

  async create(worker: Worker): Promise<string> {
    const sandbox = await Sandbox.create(worker.template, {
      ...this.options, timeoutMs: this.timeoutMs, metadata: { legalworkUser: worker.userId },
      // No GCP metadata/control-plane or other private network access.
      network: { allowPublicTraffic: false, denyOut: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] },
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    try {
      // Worker tokens are infrastructure auth, not copied desktop credentials.
      await sandbox.files.write("/data/server.json", JSON.stringify({
        host: "0.0.0.0", port: 8787, token: worker.clientToken, hostToken: worker.hostToken,
        workspaces: [{ path: "/data/projects/Assistant", name: "Assistant", preset: "assistant" }],
        authorizedRoots: ["/data/projects"], corsOrigins: [], approval: { mode: "manual" },
        autoDownloadOcr: false, logFormat: "json", logRequests: false,
      }), { user: "root" });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try { if ((await this.request({ ...worker, sandboxId: sandbox.sandboxId }, "/health", { signal: AbortSignal.timeout(2000) })).ok) return sandbox.sandboxId; }
        catch { /* envd/worker readiness is bounded below. */ }
        await Bun.sleep(250);
      }
      throw new Error("LegalWork startup did not become healthy within 120 seconds");
    } catch (error) {
      await sandbox.kill().catch(() => {});
      this.sandboxes.delete(sandbox.sandboxId);
      throw error;
    }
  }
  async connect(id: string): Promise<void> {
    if (!this.sandboxes.has(id)) {
      this.sandboxes.set(id, await Sandbox.connect(id, { ...this.options, timeoutMs: this.timeoutMs }));
    }
  }
  async request(worker: Worker, path: string, init: RequestInit = {}): Promise<Response> {
    if (!worker.sandboxId) throw new Error("Worker has no sandbox");
    const sandbox = this.sandboxes.get(worker.sandboxId);
    if (!sandbox) throw new Error("Worker has not passed the connection barrier");
    const headers = new Headers(init.headers);
    headers.set("E2b-Sandbox-Id", worker.sandboxId);
    headers.set("E2b-Sandbox-Port", "8787");
    if (sandbox.trafficAccessToken) headers.set("e2b-traffic-access-token", sandbox.trafficAccessToken);
    const route = new URL(path, "http://worker.invalid");
    if (route.origin !== "http://worker.invalid") throw new Error("Invalid worker path");
    const target = new URL(this.options.sandboxUrl);
    target.pathname = route.pathname;
    target.search = route.search;
    return fetch(target, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(120_000) });
  }
  async pause(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox || !await sandbox.pause()) throw new Error("Provider pause failed");
    this.sandboxes.delete(id);
  }
  async extend(id: string): Promise<void> {
    await this.connect(id);
    await this.sandboxes.get(id)?.setTimeout(this.timeoutMs);
  }
}
