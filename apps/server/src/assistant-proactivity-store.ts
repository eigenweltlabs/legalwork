import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { ProactiveEventSchema, ScratchpadWriteSchema, type ProactiveEvent } from "./assistant-proactivity-schema.js";
import { ASSISTANT_PROACTIVITY_INSTRUCTIONS } from "./assistant-handoff.js";
import { SessionAuthoritySchema } from "./wiki/agent-access.js";

const ScratchpadSchema = z.object({ text: z.string(), revision: z.number(), updatedAt: z.number() });
const ScratchpadSourceSchema = z.object({ sessionId: z.string(), directory: z.string(), authority: SessionAuthoritySchema });
const OfferSchema = z.object({ state: z.enum(["unoffered", "offered", "declined"]), at: z.number() });
const DeliveryContentSchema = z.object({ message: z.string(), revision: z.number() });
const AssessmentSchema = z.object({
  revision: z.number().int().nonnegative(),
  probability: z.number().finite().min(0).max(1).nullable(),
  reason: z.enum(["access_denied", "below_threshold", "matched", "assistant_silent"]),
});

/** Application-owned checkpoints; only an Assistant tool can write the scratchpad. */
export class AssistantProactivityStore {
  private constructor(private db: SqliteHandle) {}
  static async open(path: string) {
    await mkdir(dirname(path), { recursive: true });
    const db = await openSqlite(path);
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_proactivity_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_proactivity_events (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', revision INTEGER, delivery_id TEXT, session_id TEXT, decided_at INTEGER);
      CREATE TABLE IF NOT EXISTS assistant_proactivity_assessments (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    return new AssistantProactivityStore(db);
  }
  private read(key: string): unknown {
    const row = this.db.get("SELECT data FROM assistant_proactivity_state WHERE key = ?", [key]);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private write(key: string, value: unknown) {
    this.db.run("INSERT INTO assistant_proactivity_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data", [key, JSON.stringify(value)]);
  }
  scratchpad() { return ScratchpadSchema.parse(this.read("scratchpad") ?? { text: "", revision: 0, updatedAt: 0 }); }
  scratchpadSource() { return ScratchpadSourceSchema.nullable().parse(this.read("scratchpad-source") ?? null); }
  updateScratchpad(raw: unknown, now = Date.now(), source?: z.infer<typeof ScratchpadSourceSchema>) {
    const input = ScratchpadWriteSchema.parse(raw);
    return this.transaction(() => {
      const current = this.scratchpad();
      if (current.revision !== input.revision) throw new ApiError(409, "scratchpad_changed", "Read the current scratchpad before editing it again.");
      const saved = { text: input.text, revision: current.revision + 1, updatedAt: now };
      this.write("scratchpad", saved);
      // Authority is captured by the authenticated route, never from note text
      // or email data. Keep it atomic with the conditions it authorizes.
      this.write("scratchpad-source", input.text && source ? ScratchpadSourceSchema.parse(source) : null);
      return saved;
    });
  }
  briefingOffer() { return OfferSchema.parse(this.read("briefing-offer") ?? { state: "unoffered", at: 0 }); }
  markBriefingOffer(state: "offered" | "declined", now = Date.now()) {
    return this.transaction(() => {
      const previous = this.briefingOffer();
      if (state === "offered" && previous.state !== "unoffered") return false;
      this.write("briefing-offer", { state, at: now });
      return true;
    });
  }
  cursor(source: string) { return z.string().optional().parse(this.read(`cursor:${source}`)); }
  ingest(source: string, cursor: string, events: ProactiveEvent[]) {
    this.transaction(() => {
      for (const event of events) this.db.run("INSERT OR IGNORE INTO assistant_proactivity_events(id, data) VALUES (?, ?)", [event.id, JSON.stringify(ProactiveEventSchema.parse(event))]);
      this.write(`cursor:${source}`, cursor);
    });
  }
  pending() {
    return this.db.all("SELECT data FROM assistant_proactivity_events WHERE status = 'pending' ORDER BY rowid")
      .map(row => ProactiveEventSchema.parse(JSON.parse(String(row.data))));
  }
  recordAssessment(id: string, assessment: z.infer<typeof AssessmentSchema>) {
    this.db.run("INSERT INTO assistant_proactivity_assessments VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [id, JSON.stringify(AssessmentSchema.parse(assessment))]);
  }
  assessment(id: string) {
    const row = this.db.get("SELECT data FROM assistant_proactivity_assessments WHERE id = ?", [id]);
    return row ? AssessmentSchema.parse(JSON.parse(String(row.data))) : null;
  }
  settle(id: string, status: "ignored" | "sent" | "failed", revision: number, now = Date.now()) {
    this.db.run("UPDATE assistant_proactivity_events SET status = ?, revision = ?, decided_at = ? WHERE id = ?", [status, revision, now, id]);
  }
  delivery(id: string) {
    const row = this.db.get("SELECT delivery_id, session_id FROM assistant_proactivity_events WHERE id = ?", [id]);
    return row?.delivery_id && row.session_id ? { id: String(row.delivery_id), sessionId: String(row.session_id) } : null;
  }
  deliveryContent(id: string) { return DeliveryContentSchema.optional().parse(this.read(`delivery:${id}`)); }
  prepareDelivery(ids: string[], deliveryId: string, sessionId: string, message: string, revision: number) {
    return this.transaction(() => {
      if (!ids.length) throw new Error("A proactive delivery must contain events.");
      const receipts = ids.map(id => this.delivery(id)), existing = receipts.find(receipt => receipt !== null);
      if (existing) {
        if (receipts.some(receipt => receipt?.id !== existing.id || receipt.sessionId !== existing.sessionId)) throw new Error("Cannot combine an existing delivery with new events.");
        return existing;
      }
      for (const id of ids) this.db.run("UPDATE assistant_proactivity_events SET delivery_id = ?, session_id = ? WHERE id = ?", [deliveryId, sessionId, id]);
      this.write(`delivery:${deliveryId}`, { message, revision });
      return { id: deliveryId, sessionId };
    });
  }
  settleDelivery(id: string, status: "ignored" | "sent" | "failed", revision: number) {
    this.transaction(() => {
      this.db.run("UPDATE assistant_proactivity_events SET status = ?, revision = ?, decided_at = ? WHERE delivery_id = ? AND status = 'pending'", [status, revision, Date.now(), id]);
      this.db.run("DELETE FROM assistant_proactivity_state WHERE key = ?", [`delivery:${id}`]);
    });
  }
  recent() {
    return this.db.all("SELECT data FROM assistant_proactivity_events WHERE status = 'sent' ORDER BY decided_at DESC LIMIT 10")
      .map(row => ProactiveEventSchema.parse(JSON.parse(String(row.data))));
  }
  prune(now = Date.now()) {
    this.db.run("DELETE FROM assistant_proactivity_events WHERE decided_at < ?", [now - 30 * 86400_000]);
    this.db.run("DELETE FROM assistant_proactivity_assessments WHERE id NOT IN (SELECT id FROM assistant_proactivity_events)");
  }
  lease(owner: string, now = Date.now()) {
    return this.transaction(() => {
      const lease = z.object({ owner: z.string(), until: z.number() }).optional().parse(this.read("runtime-lease"));
      if (lease && lease.owner !== owner && lease.until > now) return false;
      this.write("runtime-lease", { owner, until: now + 10 * 60_000 });
      return true;
    });
  }
  release(owner: string) {
    this.transaction(() => {
      const lease = z.object({ owner: z.string(), until: z.number() }).optional().parse(this.read("runtime-lease"));
      if (lease?.owner === owner) this.write("runtime-lease", { owner, until: 0 });
    });
  }
  context() {
    const failures = Number(this.db.get("SELECT count(*) AS count FROM assistant_proactivity_events WHERE status = 'failed'")?.count ?? 0);
    return `${ASSISTANT_PROACTIVITY_INSTRUCTIONS}\n\nInternal follow-up notes (revision ${this.scratchpad().revision}; empty means nothing is being checked):\n${JSON.stringify(this.scratchpad().text)}\nMorning briefing suggestion state: ${this.briefingOffer().state}.${failures ? ` ${failures} proactive update deliveries were rejected by the engine. Do not claim those updates were delivered.` : ""}`;
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
}

const stores = new WeakMap<ServerConfig, Promise<AssistantProactivityStore>>();
export function assistantProactivityStore(config: ServerConfig) {
  let store = stores.get(config);
  if (!store) { store = AssistantProactivityStore.open(runtimeDbPath(config)); stores.set(config, store); }
  return store;
}
