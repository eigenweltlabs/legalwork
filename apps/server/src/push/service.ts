import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { openSqlite, type SqliteHandle } from "../runtime-db.js";
import { APNsConfigSchema, APNsProvider, type PushEvent, type PushTransport } from "./apns.js";

export const RegistrationSchema = z.object({
  token: z.string().regex(/^[a-fA-F0-9]{32,512}$/).transform(value => value.toLowerCase()),
  environment: z.enum(["sandbox", "production"]),
  replies: z.boolean(), approvals: z.boolean(), sounds: z.boolean(), previews: z.boolean(),
  visibleTab: z.number().int().min(-1).max(4),
});
type Registration = z.infer<typeof RegistrationSchema>;
const StoredDeviceSchema = RegistrationSchema.extend({ owner: z.string(), createdAt: z.number(), seenAt: z.number() });
const EventSchema = z.object({ id: z.string(), at: z.number(), title: z.string(), body: z.string(), tab: z.union([z.literal(0), z.literal(1)]), kind: z.enum(["reply", "approval", "test"]) });

/** Durable device registrations and delivery receipts, never raw account credentials. */
export class AssistantPush {
  private busy = false;
  private inFlight: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastTest = new Map<string, number>();
  private lastError: string | null = null;
  private constructor(private db: SqliteHandle, private provider: PushTransport | null,
    private events: () => Promise<PushEvent[]>, private ownerActive: (owner: string) => Promise<boolean>,
    private now: () => number) {}
  static async open(path: string, events: () => Promise<PushEvent[]>, ownerActive: (owner: string) => Promise<boolean>,
    options: { provider?: PushTransport | null; now?: () => number; configPath?: string } = {}) {
    await mkdir(dirname(path), { recursive: true });
    const db = await openSqlite(path);
    db.exec("CREATE TABLE IF NOT EXISTS push_devices (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS push_deliveries (device TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(device,event))");
    let provider = options.provider ?? null;
    let configurationError = false;
    if (options.provider === undefined) {
      const configPath = options.configPath ?? process.env.LEGALWORK_APNS_CONFIG ?? join(dirname(path), "apns.json");
      try { provider = await APNsProvider.open(APNsConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")))); }
      catch (error) { configurationError = !(error instanceof Error && "code" in error && error.code === "ENOENT"); }
    }
    const service = new AssistantPush(db, provider, events, ownerActive, options.now ?? Date.now);
    if (configurationError) service.lastError = "Push service configuration could not be loaded.";
    return service;
  }
  status() { return { configured: this.provider !== null, environment: this.provider?.environment ?? null, error: this.lastError }; }
  private device(id: string) {
    const row = this.db.get("SELECT data FROM push_devices WHERE id = ?", [id]);
    return row ? StoredDeviceSchema.parse(JSON.parse(String(row.data))) : null;
  }
  private owned(id: string, owner: string) {
    const device = this.device(id);
    if (device && device.owner !== owner) throw new ApiError(403, "push_owner", "This notification registration belongs to another account.");
    return device;
  }
  register(id: string, owner: string, input: Registration) {
    const previous = this.owned(id, owner);
    if (!this.provider || input.environment !== this.provider.environment) throw new ApiError(503, "push_unavailable", "Push notifications are not configured for this version of LegalWork yet.");
    const data = { ...input, owner, createdAt: previous?.createdAt ?? this.now(), seenAt: this.now() };
    // A reinstalled app can receive the same token. Only its newest registration may send.
    for (const row of this.db.all("SELECT id, data FROM push_devices")) {
      const device = StoredDeviceSchema.parse(JSON.parse(String(row.data)));
      if (row.id !== id && device.token === input.token && device.environment === input.environment) this.remove(String(row.id), device.owner);
    }
    this.db.run("INSERT INTO push_devices VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [id, JSON.stringify(data)]);
    return { registered: true, ...this.status() };
  }
  remove(id: string, owner: string) {
    this.owned(id, owner);
    this.db.run("DELETE FROM push_devices WHERE id = ?", [id]);
    this.db.run("DELETE FROM push_deliveries WHERE device = ?", [id]);
  }
  test(id: string, owner: string, delay: number) {
    if (!this.owned(id, owner)) throw new ApiError(404, "push_missing", "Enable notifications first.");
    if (this.now() - (this.lastTest.get(id) ?? -Infinity) < 60_000) throw new ApiError(429, "push_test_limit", "Wait a minute before sending another test.");
    this.lastTest.set(id, this.now());
    const event: PushEvent = { id: `test:${randomUUID()}`, at: this.now(), title: "LegalWork", body: "Apple Push is working. You can receive notifications with the app closed.", tab: 0, kind: "test" };
    this.enqueue(id, event, "pending", this.now() + delay * 1000);
    return { queued: true, delaySeconds: delay };
  }
  private enqueue(id: string, event: PushEvent, state: string, at: number) {
    this.db.run("INSERT OR IGNORE INTO push_deliveries(device,event,data,state,next_at,created_at) VALUES (?,?,?,?,?,?)", [id, event.id, JSON.stringify(event), state, at, this.now()]);
  }
  tick() {
    if (this.busy || this.stopped || !this.provider) return this.inFlight;
    this.busy = true;
    this.inFlight = this.run().catch(() => { this.lastError = "Push delivery is temporarily unavailable. LegalWork will retry."; }).finally(() => { this.busy = false; });
    return this.inFlight;
  }
  private async run() {
    const rows = this.db.all("SELECT id, data FROM push_devices");
    if (!rows.length) return;
    let events: PushEvent[] = [];
    let activityAvailable = true;
    try { events = await this.events(); }
    catch { activityAvailable = false; this.lastError = "Assistant activity is temporarily unavailable. LegalWork will retry."; }
    for (const row of rows) {
      const id = String(row.id);
      const initial = StoredDeviceSchema.parse(JSON.parse(String(row.data)));
      if (!await this.ownerActive(initial.owner) || this.now() - initial.seenAt > 30 * 86400_000) { this.remove(id, initial.owner); continue; }
      // Registration may change while reading engine state or delivering another device.
      const device = this.device(id);
      if (!device) continue;
      for (const event of events) {
        if (event.at <= device.createdAt || this.now() - event.at > 86400_000) continue;
        const enabled = event.kind === "reply" ? device.replies : device.approvals;
        const visible = device.visibleTab === event.tab && this.now() - device.seenAt < 45_000;
        this.enqueue(id, event, enabled && !visible ? "pending" : "seen", this.now());
      }
      const pending = this.db.all("SELECT event, data, attempt, created_at FROM push_deliveries WHERE device = ? AND state = 'pending' AND next_at <= ? ORDER BY created_at LIMIT 20", [id, this.now()]);
      for (const item of pending) {
        const current = this.device(id);
        if (!current || this.stopped) break;
        const event = EventSchema.parse(JSON.parse(String(item.data)));
        if (event.kind !== "test" && !activityAvailable) continue;
        const obsolete = event.kind !== "test" && !events.some(current => current.id === event.id);
        const expired = this.now() - Number(item.created_at) > 3600_000;
        const visible = current.visibleTab === event.tab && this.now() - current.seenAt < 45_000;
        const enabled = event.kind === "test" || (event.kind === "reply" ? current.replies : current.approvals);
        if (obsolete || expired || !enabled || (visible && event.kind !== "test")) {
          this.db.run("UPDATE push_deliveries SET state = 'seen' WHERE device = ? AND event = ?", [id, event.id]); continue;
        }
        let result;
        try { result = await this.provider!.send(current.token, event, current); }
        catch { result = { status: 0, reason: "NetworkError" }; }
        if (result.status === 410 || ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason ?? "")) {
          // Do not erase a newer token registered during this request.
          if (this.device(id)?.token === current.token) this.remove(id, current.owner);
          break;
        }
        if (result.status === 200) {
          this.lastError = null;
          this.db.run("UPDATE push_deliveries SET state = 'sent' WHERE device = ? AND event = ?", [id, event.id]);
        } else {
          this.lastError = `Apple Push could not deliver (${result.reason ?? result.status}).`;
          const retry = !result.status || result.status === 429 || result.status >= 500 || result.status === 403;
          this.db.run("UPDATE push_deliveries SET state = ?, attempt = attempt + 1, next_at = ? WHERE device = ? AND event = ?", [retry ? "pending" : "failed", this.now() + Math.min(900_000, 30_000 * 2 ** Math.min(Number(item.attempt), 5)), id, event.id]);
        }
      }
    }
    this.db.run("DELETE FROM push_deliveries WHERE created_at < ?", [this.now() - 30 * 86400_000]);
  }
  start() {
    const timer = setInterval(() => { void this.tick(); }, 5000);
    timer.unref();
    void this.tick();
    return async () => { this.stopped = true; clearInterval(timer); await this.inFlight; this.provider?.close(); };
  }
}
