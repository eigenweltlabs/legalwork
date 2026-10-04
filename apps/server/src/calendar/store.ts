import { CalculationPresentationSchema, CalculationRunSchema, type CalculationPresentation, type CalculationRun } from "../calculations/schema.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ICAL from "ical.js";
import { z } from "zod";
import type { CalendarItem, DeadlineCalculation } from "@legalwork/types/calendar";
import { CalendarCreateSchema, CalendarItemSchema, CalendarPatchSchema, DeadlineCalculationSchema } from "./schema.js";
import { ApiError } from "../errors.js";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { zonedInstant, zoneValid } from "./dates.js";
import { emptyCalendar, itemCalendar, parseCalendar, serializeCalendar, updateCalendar, calendarAttachmentPaths } from "./ical.js";
import type { DeadlineResult } from "./deadline-rules.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export class CalendarStore {
  private constructor(private db: SqliteHandle) {}
  static async open(path: string) {
    await mkdir(dirname(path), { recursive: true });
    const db = await openSqlite(path);
    db.exec(`CREATE TABLE IF NOT EXISTS calendar_items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, uid TEXT NOT NULL, data TEXT NOT NULL,
      remote_revision INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1, replica INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, uid));
      CREATE TABLE IF NOT EXISTS calendar_history (item_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(item_id, revision));
      CREATE TABLE IF NOT EXISTS deadline_calculations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calculation_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calculation_presentations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_conflicts (item_id TEXT PRIMARY KEY, remote TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_reminders (key TEXT PRIMARY KEY, data TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS calendar_feeds (hash TEXT PRIMARY KEY, project_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_subscriptions (account TEXT NOT NULL, scope TEXT NOT NULL, token TEXT NOT NULL, content_hash TEXT,
        PRIMARY KEY(account, scope));`);
    return new CalendarStore(db);
  }
  list(projectId: string, deleted = false): CalendarItem[] {
    return this.db.all("SELECT data FROM calendar_items WHERE project_id = ?", [projectId]).map(row => CalendarItemSchema.parse(JSON.parse(String(row.data)))).filter(item => deleted || !item.deletedAt);
  }
  get(projectId: string, id: string): CalendarItem {
    const row = this.db.get("SELECT data FROM calendar_items WHERE project_id = ? AND id = ?", [projectId, id]);
    if (!row) throw new ApiError(404, "calendar_not_found", "Calendar entry not found.");
    return CalendarItemSchema.parse(JSON.parse(String(row.data)));
  }
  private write(item: CalendarItem, expected?: number, remoteRevision?: number, replica = false, transaction = true): CalendarItem {
    CalendarItemSchema.parse(item);
    if (transaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.get("SELECT data FROM calendar_items WHERE id = ?", [item.id]);
      const current = old ? CalendarItemSchema.parse(JSON.parse(String(old.data))) : null;
      if (expected !== undefined && current?.revision !== expected) throw new ApiError(409, "calendar_conflict", "This deadline changed. Review the current entry before saving.", { current });
      if (current && (current.uid !== item.uid || current.projectId !== item.projectId)) throw new ApiError(409, "calendar_identity", "Calendar identity cannot change.");
      this.db.run(`INSERT INTO calendar_items (id, project_id, uid, data, remote_revision, dirty, replica) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, remote_revision = CASE WHEN ? IS NULL THEN calendar_items.remote_revision ELSE excluded.remote_revision END,
        dirty = excluded.dirty, replica = CASE WHEN ? IS NULL THEN calendar_items.replica ELSE excluded.replica END`,
        [item.id, item.projectId, item.uid, JSON.stringify(item), remoteRevision ?? 0, remoteRevision === undefined ? 1 : 0, replica ? 1 : 0, remoteRevision ?? null, remoteRevision ?? null]);
      this.db.run("INSERT INTO calendar_history (item_id, revision, data) VALUES (?, ?, ?)", [item.id, item.revision, JSON.stringify(item)]);
      this.db.run("DELETE FROM calendar_reminders WHERE delivered = 0 AND json_extract(data, '$.itemId') = ?", [item.id]);
      if (transaction) this.db.exec("COMMIT"); return item;
    } catch (error) { if (transaction) this.db.exec("ROLLBACK"); throw error; }
  }
  private checkedCalculation(projectId: string, calculationId: string, input: Pick<CalendarItem, "kind" | "start" | "timeZone">, reviewed = false): DeadlineCalculation {
    for (const row of this.db.all("SELECT data FROM calculation_presentations WHERE project_id = ?", [projectId])) {
      const card = CalculationPresentationSchema.parse(JSON.parse(String(row.data)));
      if (card.mode === "confirm" && !reviewed && card.state !== "saved" && card.runs.some(run => run.results.some(result => result.calculationId === calculationId))) {
        throw new ApiError(409, "calculation_review_required", "This calculation requires review in its card. Do not save it in the background.");
      }
    }
    const row = this.db.get("SELECT data FROM deadline_calculations WHERE id = ? AND project_id = ?", [calculationId, projectId]);
    if (!row) throw new ApiError(404, "calculation_not_found", "Calculate this deadline with its installed skill first.");
    const calculation = DeadlineCalculationSchema.parse(JSON.parse(String(row.data)));
    if (input.kind !== "deadline" || input.start !== calculation.deadlineDay || input.timeZone !== calculation.timeZone) throw new ApiError(400, "calculation_mismatch", "The entered deadline must match the calculation receipt.");
    return calculation;
  }
  create(projectId: string, raw: unknown, calculationId?: string, review?: { id: string; transaction: boolean }): CalendarItem {
    const input = CalendarCreateSchema.parse(raw), now = new Date().toISOString(), id = randomUUID();
    const calculation = calculationId ? this.checkedCalculation(projectId, calculationId, input, !!review) : null;
    const item: CalendarItem = { ...input, id, uid: `${id}@legalwork`, projectId, end: input.end ?? null,
      status: "active", verified: !!review, provenance: calculation ? { kind: "calculated", calculation } : { kind: "manual", source: input.source, reason: input.reason },
      revision: 1, createdAt: now, updatedAt: now, deletedAt: null, ical: "" };
    this.validateDates(item); item.ical = itemCalendar(item); return this.write(item, undefined, undefined, false, review?.transaction ?? true);
  }
  patch(projectId: string, id: string, raw: unknown): CalendarItem {
    const { revision, source, reason, calculationId, ...patch } = CalendarPatchSchema.parse(raw), current = this.get(projectId, id);
    if (current.deletedAt) throw new ApiError(410, "calendar_deleted", "Restore this entry before editing it.");
    const item = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    if (calculationId) {
      item.provenance = { kind: "calculated", calculation: this.checkedCalculation(projectId, calculationId, item) };
      item.verified = false;
    } else if (patch.start !== undefined || patch.timeZone !== undefined || source !== undefined || reason !== undefined) {
      if (current.provenance.kind === "calculated" && !reason?.trim()) throw new ApiError(400, "override_reason_required", "Record why the calculated deadline is being overridden.");
      item.provenance = { kind: "manual", source: source ?? (current.provenance.kind === "manual" ? current.provenance.source : ""), reason: reason ?? "" };
      item.verified = false;
    }
    const changed = new Set(Object.keys(patch));
    if (calculationId || (current.provenance.kind === "calculated" && item.provenance.kind === "manual")) changed.add("reminders");
    this.validateDates(item); item.ical = updateCalendar(item, changed); return this.write(item, revision);
  }
  remove(projectId: string, id: string, revision: number, restore = false) {
    const current = this.get(projectId, id), now = new Date().toISOString();
    return this.write({ ...current, deletedAt: restore ? null : now, updatedAt: now, revision: current.revision + 1 }, revision);
  }
  history(projectId: string, id: string) {
    this.get(projectId, id);
    return this.db.all("SELECT data FROM calendar_history WHERE item_id = ? ORDER BY revision DESC", [id]).map(row => CalendarItemSchema.parse(JSON.parse(String(row.data))));
  }
  recordCalculation(projectId: string, result: Omit<DeadlineResult, "input"> & { input: Record<string, unknown> }, codeHash: string): DeadlineCalculation {
    const receipt = DeadlineCalculationSchema.parse({ ...result, id: randomUUID(), inputHash: hash(JSON.stringify(result.input)), codeHash, createdAt: new Date().toISOString() });
    this.db.run("INSERT INTO deadline_calculations (id, project_id, data) VALUES (?, ?, ?)", [receipt.id, projectId, JSON.stringify(receipt)]); return receipt;
  }
  calculation(projectId: string, id: string) {
    const row = this.db.get("SELECT data FROM deadline_calculations WHERE id = ? AND project_id = ?", [id, projectId]);
    if (!row) throw new ApiError(404, "calculation_not_found", "Calculation not found in this project.");
    return DeadlineCalculationSchema.parse(JSON.parse(String(row.data)));
  }
  recordRun(projectId: string, run: CalculationRun) {
    CalculationRunSchema.parse(run);
    this.db.run("INSERT INTO calculation_runs (id, project_id, data) VALUES (?, ?, ?)", [run.id, projectId, JSON.stringify(run)]);
    return run;
  }
  run(projectId: string, id: string) {
    const row = this.db.get("SELECT data FROM calculation_runs WHERE id = ? AND project_id = ?", [id, projectId]);
    if (!row) throw new ApiError(404, "calculation_not_found", "Calculation not found in this project.");
    return CalculationRunSchema.parse(JSON.parse(String(row.data)));
  }
  recordPresentation(card: CalculationPresentation, supersedes?: string) {
    CalculationPresentationSchema.parse(card);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (supersedes) {
        const old = this.presentation(card.workspaceId, supersedes);
        if (old.sessionId !== card.sessionId || old.state === "saved") throw new ApiError(409, "calculation_review_closed", "Only an unsaved card in this conversation can be replaced.");
        old.state = "rejected";
        this.db.run("UPDATE calculation_presentations SET data = ? WHERE id = ?", [JSON.stringify(old), old.id]);
      }
      this.db.run("INSERT INTO calculation_presentations (id, project_id, data) VALUES (?, ?, ?)", [card.id, card.workspaceId, JSON.stringify(card)]);
      this.db.exec("COMMIT"); return card;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  presentation(projectId: string, id: string) {
    const row = this.db.get("SELECT data FROM calculation_presentations WHERE id = ? AND project_id = ?", [id, projectId]);
    if (!row) throw new ApiError(404, "calculation_not_found", "Calculation card not found in this project.");
    return CalculationPresentationSchema.parse(JSON.parse(String(row.data)));
  }
  decidePresentation(projectId: string, id: string, action: "save" | "reject" | "acknowledge") {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.presentation(projectId, id);
      if (["saved", "acknowledged", "rejected"].includes(card.state)) {
        const expected = action === "save" ? "saved" : action === "reject" ? "rejected" : "acknowledged";
        if (card.state !== expected) throw new ApiError(409, "calculation_review_closed", "This review is closed. Present a new calculation after corrections.");
        this.db.exec("COMMIT"); return card;
      }
      if (action === "save") {
        if (card.runs.some(run => run.status !== "calculated") || !card.runs.some(run => run.results.length)) throw new ApiError(409, "calculation_no_date", "Missing information cannot be saved as a deadline.");
        card.itemIds = card.runs.flatMap(run => run.results.map(result => this.create(projectId, {
          kind: "deadline", title: card.runs.length === 1 && run.results.length === 1 ? card.title : result.title,
          start: result.date, timeZone: result.timeZone, description: card.selection,
          attachmentPaths: [...new Set(card.sources.map(source => source.path))], sessionIds: card.sessionId ? [card.sessionId] : [],
        }, result.calculationId, { id, transaction: false }).id));
        card.state = "saved";
      } else card.state = action === "reject" ? "rejected" : "acknowledged";
      this.db.run("UPDATE calculation_presentations SET data = ? WHERE id = ? AND project_id = ?", [JSON.stringify(card), id, projectId]);
      this.db.exec("COMMIT"); return card;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  import(projectId: string, text: string, source: string, expected: Record<string, number> = {}, zone = "Europe/Berlin"): CalendarItem[] {
    const root = parseCalendar(text), grouped = new Map<string, ICAL.Component[]>();
    if (!zoneValid(zone)) throw new ApiError(400, "invalid_timezone", "Choose a valid time zone for floating calendar dates.");
    for (const c of root.getAllSubcomponents()) {
      if (c.name === "vtimezone") continue;
      const uid = String(c.getFirstPropertyValue("uid")); grouped.set(uid, [...(grouped.get(uid) ?? []), c]);
    }
    const zoneBytes = root.getAllSubcomponents("vtimezone").reduce((size, zone) => size + Buffer.byteLength(zone.toString()), 0);
    if (zoneBytes * grouped.size + Buffer.byteLength(text) > 8_000_000) throw new ApiError(413, "calendar_too_large", "The time-zone definitions make this import too large. Split the calendar into smaller imports.");
    const prepared = [...grouped].map(([uid, entries]) => {
      const masters = entries.filter(c => !c.hasProperty("recurrence-id"));
      if (masters.length !== 1 || new Set(entries.map(c => c.name)).size !== 1) throw new ApiError(400, "invalid_icalendar", "Each UID needs one master of a single component type.");
      const master = masters[0], previous = this.list(projectId, true).find(item => item.uid === uid);
      if (previous && expected[uid] !== previous.revision) throw new ApiError(409, "calendar_conflict", "Provide the current revision to replace an imported series.", { current: previous });
      const calendar = emptyCalendar();
      for (const p of root.getAllProperties()) if (!["version", "prodid"].includes(p.name)) calendar.addProperty(new ICAL.Property(p.toJSON()));
      for (const c of [...root.getAllSubcomponents("vtimezone"), ...entries]) calendar.addSubcomponent(ICAL.Component.fromString(c.toString()));
      const start = master.name === "vtodo" ? master.getFirstPropertyValue("due") ?? master.getFirstPropertyValue("dtstart") : master.getFirstPropertyValue("dtstart");
      const end = master.name === "vtodo" ? null : master.getFirstPropertyValue("dtend");
      const now = new Date().toISOString(), status = master.getFirstPropertyValue("status"), localStatus = master.getFirstPropertyValue("x-legalwork-status");
      const localKind = master.getFirstPropertyValue("x-legalwork-kind");
      const item: CalendarItem = { id: previous?.id ?? randomUUID(), uid, projectId,
        kind: localKind === "deadline" ? "deadline" : master.name === "vtodo" ? "deadline" : master.name === "vjournal" ? "journal" : master.name === "vfreebusy" ? "freebusy" : "event",
        title: String(master.getFirstPropertyValue("summary") ?? "Calendar entry"), description: String(master.getFirstPropertyValue("description") ?? ""),
        start: start instanceof ICAL.Time ? start.toString() : null, end: end instanceof ICAL.Time ? end.toString() : null,
        timeZone: zone, status: localStatus === "cancelled" || status === "CANCELLED" ? "cancelled" : localStatus === "completed" || status === "COMPLETED" ? "completed" : "active", verified: false,
        attachmentPaths: (previous?.attachmentPaths ?? []).filter(path => calendarAttachmentPaths(master).includes(path)), sessionIds: previous?.sessionIds ?? [],
        assigneeUserId: previous?.assigneeUserId ?? null, taskIds: previous?.taskIds ?? [], reminders: [], provenance: { kind: "imported", source },
        ical: serializeCalendar(calendar), revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now, deletedAt: null };
      return { item, expected: previous?.revision };
    });
    // Validate the complete document before modifying any existing series.
    for (const { item } of prepared) CalendarItemSchema.parse(item);
    return prepared.map(({ item, expected: revision }) => this.write(item, revision));
  }
  private validateDates(item: CalendarItem) {
    if (!zoneValid(item.timeZone)) throw new ApiError(400, "invalid_timezone", "Choose a valid IANA time zone.");
    if (item.start && item.end && (item.start.length === 10) !== (item.end.length === 10)) throw new ApiError(400, "calendar_date_type", "Start and end must use the same date type.");
    if (item.start) zonedInstant(item.start, item.timeZone);
    if (item.end && item.start && zonedInstant(item.end, item.timeZone) <= zonedInstant(item.start, item.timeZone)) throw new ApiError(400, "calendar_end", "The exclusive end must follow the start.");
  }
  pending(projectId: string) {
    return this.db.all("SELECT data, remote_revision FROM calendar_items WHERE project_id = ? AND dirty = 1", [projectId])
      .map(row => ({ data: CalendarItemSchema.parse(JSON.parse(String(row.data))), baseRevision: Number(row.remote_revision) }));
  }
  receive(projectId: string, remote: CalendarItem, sentRevision?: number) {
    const row = this.db.get("SELECT data, dirty, remote_revision FROM calendar_items WHERE id = ?", [remote.id]);
    const current = row ? CalendarItemSchema.parse(JSON.parse(String(row.data))) : null;
    const item = { ...remote, projectId, sessionIds: current?.sessionIds ?? [] };
    if (current && row?.dirty === 1 && current.revision !== sentRevision) {
      if (item.revision > Number(row.remote_revision)) this.db.run("INSERT OR REPLACE INTO calendar_conflicts (item_id, remote) VALUES (?, ?)", [item.id, JSON.stringify(item)]);
      return;
    }
    if (current && row?.dirty === 0 && Number(row.remote_revision) >= remote.revision) return;
    const history = this.db.get("SELECT MAX(revision) AS revision FROM calendar_history WHERE item_id = ?", [item.id]);
    const nextRevision = current ? current.revision + 1 : Math.max(item.revision, Number(history?.revision ?? 0) + 1);
    this.write({ ...item, revision: nextRevision }, undefined, remote.revision, true);
    this.db.run("DELETE FROM calendar_conflicts WHERE item_id = ?", [item.id]);
  }
  conflicts(projectId: string) {
    return this.db.all("SELECT c.remote FROM calendar_conflicts c JOIN calendar_items i ON i.id = c.item_id WHERE i.project_id = ?", [projectId]).map(row => CalendarItemSchema.parse(JSON.parse(String(row.remote))));
  }
  resolve(projectId: string, id: string, revision: number, keep: "mine" | "theirs") {
    const current = this.get(projectId, id), remote = this.conflicts(projectId).find(item => item.id === id);
    if (!remote || current.revision !== revision) throw new ApiError(409, "calendar_conflict", "Reload the conflicting deadline before choosing a revision.");
    if (keep === "theirs") this.receive(projectId, remote, revision);
    else {
      this.write({ ...current, revision: Math.max(current.revision, remote.revision) + 1, updatedAt: new Date().toISOString() }, revision);
      this.db.run("UPDATE calendar_items SET remote_revision = ? WHERE id = ?", [remote.revision, id]);
      this.db.run("DELETE FROM calendar_conflicts WHERE item_id = ?", [id]);
    }
    return this.get(projectId, id);
  }
  withdraw(projectId: string, keepLocal: boolean) {
    if (keepLocal) this.db.run("UPDATE calendar_items SET replica = 0, remote_revision = 0, dirty = 1 WHERE project_id = ?", [projectId]);
    else this.db.run("DELETE FROM calendar_items WHERE project_id = ? AND replica = 1", [projectId]);
  }
  createFeed(projectId: string | null) {
    const token = `${randomUUID()}${randomUUID()}`;
    this.db.run("INSERT INTO calendar_feeds (hash, project_id, created_at) VALUES (?, ?, ?)", [hash(token), projectId, new Date().toISOString()]); return token;
  }
  feed(token: string): { projectId: string | null } | null {
    const row = this.db.get("SELECT project_id FROM calendar_feeds WHERE hash = ?", [hash(token)]);
    return row ? { projectId: row.project_id === null ? null : String(row.project_id) } : null;
  }
  revokeFeed(token: string) { this.db.run("DELETE FROM calendar_feeds WHERE hash = ?", [hash(token)]); }
  subscriptions(account: string) {
    return this.db.all("SELECT scope, token, content_hash FROM calendar_subscriptions WHERE account = ?", [account]).map(row => ({
      workspaceId: String(row.scope) || null, token: String(row.token), contentHash: row.content_hash === null ? null : String(row.content_hash),
    }));
  }
  saveSubscription(account: string, workspaceId: string | null, token: string, contentHash: string) {
    this.db.run(`INSERT INTO calendar_subscriptions (account, scope, token, content_hash) VALUES (?, ?, ?, ?)
      ON CONFLICT(account, scope) DO UPDATE SET token = excluded.token, content_hash = excluded.content_hash`, [account, workspaceId ?? "", token, contentHash]);
  }
  removeSubscription(account: string, workspaceId: string | null) {
    this.db.run("DELETE FROM calendar_subscriptions WHERE account = ? AND scope = ?", [account, workspaceId ?? ""]);
  }
  enqueueReminder(key: string, data: unknown) { this.db.run("INSERT INTO calendar_reminders (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data WHERE delivered = 0", [key, JSON.stringify(data)]); }
  claimReminders(allowedProjects?: Set<string>, userId: string | null = null) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = allowedProjects ? this.db.all(`SELECT r.key, r.data FROM calendar_reminders r JOIN calendar_items i ON i.id = json_extract(r.data, '$.itemId')
        WHERE r.delivered = 0 AND i.project_id IN (SELECT value FROM json_each(?))
        AND json_extract(i.data, '$.deletedAt') IS NULL AND json_extract(i.data, '$.status') = 'active'
        AND (json_extract(i.data, '$.assigneeUserId') IS NULL OR json_extract(i.data, '$.assigneeUserId') = ?) LIMIT 100`, [JSON.stringify([...allowedProjects]), userId])
        : this.db.all("SELECT key, data FROM calendar_reminders WHERE delivered = 0 LIMIT 100");
      const claimed = [];
      for (const row of rows) {
        const data = z.record(z.string(), z.unknown()).parse(JSON.parse(String(row.data)));
        if (allowedProjects) {
          if (typeof data.projectId !== "string" || !allowedProjects.has(data.projectId) || typeof data.itemId !== "string") continue;
          let item; try { item = this.get(data.projectId, data.itemId); } catch { continue; }
          if (item.deletedAt || item.status !== "active" || (item.assigneeUserId && item.assigneeUserId !== userId)) continue;
        }
        this.db.run("UPDATE calendar_reminders SET delivered = 1 WHERE key = ?", [String(row.key)]); claimed.push(data);
      }
      this.db.exec("COMMIT"); return claimed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
const stores = new Map<string, Promise<CalendarStore>>();
export function calendarStore(config: ServerConfig) {
  const path = runtimeDbPath(config); let store = stores.get(path);
  if (!store) { store = CalendarStore.open(path); stores.set(path, store); } return store;
}
