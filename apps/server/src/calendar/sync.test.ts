import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CalendarItemSchema, type CalendarItem } from "@legalwork/types/calendar";
import type { ServerConfig } from "../types.js";
import type { ProjectLink } from "../project-sync-store.js";
import { calendarStore } from "./store.js";
import { syncProjectCalendar } from "./sync.js";

test("calendar HTTP sync survives offline edits, maps project IDs, resolves concurrent changes and withdraws member copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "calendar-sync-")), canonical = randomUUID();
  const config = (name: string): ServerConfig => ({ host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, name, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false });
  const link = (name: string, role: "owner" | "member"): ProjectLink => ({ workspaceId: name, projectId: canonical, orgId: "org_test", origin: role === "owner" ? "local" : "remote", role, ownerUserId: "owner", settings: { access: "members", memberIds: ["member"], scope: { metadata: false, notes: false, tasks: false, calendar: true, recordings: false, reviews: false, documents: false } }, confirmed: true, remoteUpdatedAt: null, filesReconciledAt: null, state: "active", allowDeletions: false, lastSyncAt: null, lastError: null, report: null });
  const remote = new Map<string, CalendarItem>(), writes: CalendarItem[] = [];
  let offline = true;
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (offline) return Response.json({ code: "unavailable", message: "offline" }, { status: 503 });
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    expect(new URL(request.url).pathname).toBe(`/api/projects/${canonical}/calendar`);
    if (request.method === "GET") return Response.json({ items: [...remote.values()] });
    const body = z.object({ items: z.array(z.object({ data: CalendarItemSchema, baseRevision: z.number() })) }).parse(await request.json());
    const items = [], conflicts = [];
    for (const entry of body.items) {
      expect(entry.data.projectId).toBe(canonical); expect(entry.data.taskIds).toEqual([]); expect(entry.data.sessionIds).toEqual([]); writes.push(entry.data);
      const current = remote.get(entry.data.id);
      if ((current?.revision ?? 0) !== entry.baseRevision) { if (current) conflicts.push(current); continue; }
      const next = { ...entry.data, revision: (current?.revision ?? 0) + 1 }; remote.set(next.id, next); items.push(next);
    }
    return Response.json({ items, conflicts });
  } });
  const client = { platformURL: `http://127.0.0.1:${endpoint.port}`, platformToken: "test-token" };
  try {
    const alice = config("alice"), bob = config("bob"), a = await calendarStore(alice), b = await calendarStore(bob);
    const aliceLink = link("alice-local", "owner"), bobLink = link("bob-local", "member");
    const original = a.create(aliceLink.workspaceId, { title: "Deadline", start: "2026-09-30", sessionIds: ["ses_alice"], attachmentPaths: ["Order.pdf"], taskIds: [randomUUID()] });
    await expect(syncProjectCalendar(alice, client, aliceLink)).rejects.toThrow();
    expect(a.pending(aliceLink.workspaceId)).toHaveLength(1);
    offline = false; await syncProjectCalendar(alice, client, aliceLink); await syncProjectCalendar(bob, client, bobLink);
    expect(a.pending(aliceLink.workspaceId)).toHaveLength(0);
    expect(b.get(bobLink.workspaceId, original.id).projectId).toBe(bobLink.workspaceId);
    expect(a.get(aliceLink.workspaceId, original.id).sessionIds).toEqual(["ses_alice"]);
    expect(b.get(bobLink.workspaceId, original.id).sessionIds).toEqual([]);
    expect(b.get(bobLink.workspaceId, original.id).attachmentPaths).toEqual(["Order.pdf"]);
    const beforeA = a.get(aliceLink.workspaceId, original.id), beforeB = b.get(bobLink.workspaceId, original.id);
    a.patch(aliceLink.workspaceId, original.id, { revision: beforeA.revision, start: "2026-10-01" });
    const mine = b.patch(bobLink.workspaceId, original.id, { revision: beforeB.revision, start: "2026-10-02" });
    await syncProjectCalendar(alice, client, aliceLink); await syncProjectCalendar(bob, client, bobLink);
    expect(b.get(bobLink.workspaceId, original.id).start).toBe("2026-10-02");
    expect(b.conflicts(bobLink.workspaceId)[0].start).toBe("2026-10-01");
    b.resolve(bobLink.workspaceId, original.id, mine.revision, "mine");
    await syncProjectCalendar(bob, client, bobLink); await syncProjectCalendar(alice, client, aliceLink);
    expect(a.get(aliceLink.workspaceId, original.id).start).toBe("2026-10-02");
    await syncProjectCalendar(bob, client, { ...bobLink, settings: { ...bobLink.settings, scope: { ...bobLink.settings.scope, calendar: false } } });
    expect(b.list(bobLink.workspaceId)).toHaveLength(0);
    await syncProjectCalendar(alice, client, { ...aliceLink, settings: { ...aliceLink.settings, scope: { ...aliceLink.settings.scope, calendar: false } } });
    expect(a.get(aliceLink.workspaceId, original.id).uid).toBe(original.uid);
    expect(writes.length).toBeGreaterThan(2);
  } finally { endpoint.stop(true); await rm(root, { recursive: true, force: true }); }
});
