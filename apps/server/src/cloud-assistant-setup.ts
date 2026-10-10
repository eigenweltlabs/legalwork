import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloudAssistantStatus } from "@legalwork/types/cloud-assistant";
import { ApiError } from "./errors.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { requireIntakeClient } from "./eigenwelt-intake.js";
import { runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { CloudReplica } from "./cloud-sync/replica.js";
import { SyncConfigSchema } from "./cloud-sync/schema.js";

const Saved = z.strictObject({ version: z.literal(1), userId: z.string(), orgId: z.string(), accountId: z.string(),
  deviceId: z.string(), enabled: z.boolean(), state: z.enum(["off", "preparing", "syncing", "starting", "enabled", "error"]), error: z.string().nullable() });
const Remote = z.object({ userId: z.string(), orgId: z.string(), accountId: z.string(), canEnable: z.boolean(),
  enabled: z.boolean(), state: z.enum(["off", "starting", "ready", "failed"]), error: z.string().nullable() });

/** Desktop-local setup state. Provider/controller credentials stay in Model API. */
export class CloudAssistantSetup {
  private saved: z.infer<typeof Saved> | null = null;
  private replica: CloudReplica | null = null;
  private stopReplica: (() => Promise<void>) | null = null;
  private pending: Promise<void> | null = null;
  private enabling: Promise<CloudAssistantStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private path: string;
  private constructor(private options: { config: ServerConfig; idle: () => Promise<boolean> }) {
    this.path = join(dirname(runtimeDbPath(options.config)), "cloud-assistant-setup.json");
  }
  static async open(options: { config: ServerConfig; idle: () => Promise<boolean> }) {
    const service = new CloudAssistantSetup(options);
    try { service.saved = Saved.parse(JSON.parse(await readFile(service.path, "utf8"))); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (service.saved && ["preparing", "syncing", "starting"].includes(service.saved.state))
      await service.save({ ...service.saved, enabled: false, state: "error", error: "Setup was interrupted. Enable Cloud assistant to resume." });
    if (service.saved?.enabled && await service.matches()) {
      try { await service.attach(); }
      catch { await service.save({ ...service.saved, enabled: false, state: "error", error: "Cloud sync could not reconnect. Try enabling it again." }); }
    }
    service.timer = setInterval(() => { void service.checkAccount().catch(() => {}); }, 5000);
    service.timer.unref();
    return service;
  }
  private async matches() {
    const account = (await readEigenweltConnection(this.options.config)).account;
    return Boolean(this.saved && account?.userId === this.saved.userId && account.orgId === this.saved.orgId);
  }
  async enabled() { await this.checkAccount(); return Boolean(this.saved?.enabled && await this.matches()); }
  async status(): Promise<CloudAssistantStatus> {
    const account = (await readEigenweltConnection(this.options.config)).account;
    const matched = await this.matches();
    return { connected: Boolean(account?.userId && account.orgId), enabled: matched && Boolean(this.saved?.enabled),
      state: matched ? this.saved?.state ?? "off" : "off", error: matched ? this.saved?.error ?? null : null, accountName: account?.orgName ?? null,
      sync: matched ? this.replica?.syncStatus() : undefined };
  }
  private async save(value: z.infer<typeof Saved>) {
    this.saved = Saved.parse(value);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.saved), { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
  private async remote(method: "GET" | "POST" | "DELETE") {
    await ensureFreshPlatformToken(this.options.config);
    if (this.saved && !await this.matches()) throw new ApiError(409, "cloud_account_changed", "Sign in to the account that started this setup.");
    const { platformURL, platformToken } = requireIntakeClient(await readEigenweltConnection(this.options.config));
    const response = await fetch(`${platformURL.replace(/\/$/, "")}/api/desktop/assistant/cloud`, { method, redirect: "error",
      headers: { Authorization: `Bearer ${platformToken}` }, signal: AbortSignal.timeout(65000) });
    if (!response.ok) throw new ApiError(response.status, "cloud_setup_unavailable", "Cloud setup is unavailable for this account. Your desktop remains available.");
    const value = Remote.parse(await response.json());
    const account = (await readEigenweltConnection(this.options.config)).account;
    if (!account || value.userId !== account.userId || value.orgId !== account.orgId) throw new ApiError(409, "cloud_account_changed", "Your account changed during setup.");
    return value;
  }
  private async attach(start = true) {
    if (this.replica) return this.replica;
    if (this.options.config.cloudSync) throw new ApiError(409, "cloud_sync_already_configured", "This runtime already has a cloud sync profile.");
    if (!this.saved || !await this.matches()) throw new ApiError(409, "cloud_account_changed", "Connect your Eigenwelt account first.");
    const replica = await CloudReplica.open(this.options.config, SyncConfigSchema.parse({ version: 1, accountId: this.saved.accountId,
      deviceId: this.saved.deviceId, deviceName: "Desktop", store: { type: "platform" }, role: "companion", projectsDirectory: this.options.config.projectsDirectory }));
    this.replica = replica;
    if (start) this.stopReplica = replica.start(true);
    return replica;
  }
  async enable() {
    if (this.enabling) return this.enabling;
    this.enabling = this.beginEnable();
    try { return await this.enabling; } finally { this.enabling = null; }
  }
  private async beginEnable() {
    if (this.options.config.readOnly) throw new ApiError(403, "read_only", "Cloud setup needs a writable desktop.");
    if (this.pending) return this.status();
    const account = (await readEigenweltConnection(this.options.config)).account;
    if (!account?.userId || !account.orgId) throw new ApiError(403, "cloud_sign_in", "Sign in with Eigenwelt in Settings first.");
    await this.checkAccount();
    if (await this.enabled()) return this.status();
    // The first remote check does not upload files or create a VM.
    const remote = await this.remote("GET");
    if (!remote.canEnable) throw new ApiError(403, "cloud_model_allowance", "This account needs an assistant model allowance.");
    await this.save({ version: 1, userId: account.userId, orgId: account.orgId, accountId: remote.accountId,
      deviceId: await this.matches() && this.saved ? this.saved.deviceId : `desktop_${randomUUID().replaceAll("-", "")}`,
      enabled: false, state: "preparing", error: null });
    const run = this.setup().catch(async () => {
      await this.detach();
      if (this.saved) await this.save({ ...this.saved, enabled: false, state: "error", error: "Cloud setup could not finish. Try again; your desktop is still available." });
    }).finally(() => { this.pending = null; });
    this.pending = run;
    return this.status();
  }
  private async setup() {
    const replica = await this.attach(false);
    await this.stage("syncing");
    await replica.prepareAssistant();
    if (!(await replica.control()).value.checkpoint) {
      const release = await this.options.config.cloudSync?.beginCheckpoint?.();
      try {
        if (!await this.options.idle()) throw new ApiError(409, "cloud_assistant_busy", "Wait for the assistant to finish, then enable cloud again.");
        await replica.seedCompanion();
      } finally { release?.(); }
    }
    // Bulk projects continue while the controller starts the VM.
    this.stopReplica = replica.start(true);
    await this.stage("starting");
    let remote = await this.remote("POST");
    const deadline = Date.now() + 300000;
    while (remote.state === "starting" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      remote = await this.remote("GET");
    }
    if (!remote.enabled || remote.state !== "ready") throw new Error("Cloud startup failed");
    await this.stage("enabled");
  }
  private async stage(state: z.infer<typeof Saved>["state"]) {
    if (!this.saved || !await this.matches()) throw new Error("Account changed");
    await this.save({ ...this.saved, state, enabled: state === "enabled", error: null });
  }
  private async detach() {
    if (!this.replica) return;
    const replica = this.replica;
    this.replica = null;
    if (this.stopReplica) await this.stopReplica(); else replica.close();
    this.stopReplica = null;
    if (this.options.config.cloudSync?.canExecute === replica.canExecute) delete this.options.config.cloudSync;
  }
  private async checkAccount() {
    if (this.saved && !await this.matches()) {
      await this.detach();
      if (!this.pending) this.saved = null;
    }
  }
  async disable() {
    if (this.pending || this.enabling) throw new ApiError(409, "cloud_setup_busy", "Wait for setup to finish.");
    if (!this.saved || !await this.matches()) return this.status();
    await this.remote("DELETE");
    await this.detach();
    await this.save({ ...this.saved, enabled: false, state: "off", error: null });
    return this.status();
  }
  async close() { if (this.timer) clearInterval(this.timer); await this.enabling; await this.pending; await this.detach(); }
}
