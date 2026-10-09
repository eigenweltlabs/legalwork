import { createHash } from "node:crypto";
import { z } from "zod";
import type { CalendarItem } from "@legalwork/types/calendar";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { intakeRequest, requireIntakeClient } from "../eigenwelt-intake.js";
import { projectSyncStore } from "../project-sync-store.js";
import { calendarExportItems } from "./service.js";
import { parseCalendar, serializeCalendar } from "./ical.js";
import { calendarStore } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const FeedList = z.object({ entitled: z.boolean(), feeds: z.array(z.object({ id: z.string(), updatedAt: z.string() })) });

async function context(config: ServerConfig) {
  await ensureFreshPlatformToken(config).catch(() => null);
  const connection = await readEigenweltConnection(config);
  if (!connection.account || !connection.platformToken) return null;
  const client = requireIntakeClient(connection);
  return { client, identity: connection.account, account: JSON.stringify([client.platformURL, connection.account.orgId, connection.account.userId]) };
}
type Context = NonNullable<Awaited<ReturnType<typeof context>>>;
async function checkAccount(config: ServerConfig, ctx: Context) {
  const { account } = await readEigenweltConnection(config);
  if (account?.userId !== ctx.identity.userId || account.orgId !== ctx.identity.orgId) throw new ApiError(409, "account_changed", "Your account changed. Reopen the calendar subscription.");
}

/** An owner-only copy for private calendars; member data is always read live by the platform. */
export async function subscriptionPayload(config: ServerConfig, identity: { orgId: string; userId: string }, workspaceId: string | null) {
  const links = await projectSyncStore(config);
  const entries: { projectId: string | null; name: string; items: CalendarItem[] }[] = [];
  let projectId: string | null = null;
  const workspaces = config.workspaces.filter(workspace => workspace.workspaceType !== "remote" && (!workspaceId || workspace.id === workspaceId));
  if (workspaceId && !workspaces.length) return null;
  for (const workspace of workspaces) {
    const link = links.linkByWorkspace(workspace.id);
    // Switching accounts must never republish another firm's cached calendars.
    if (link && (link.orgId !== identity.orgId || (link.role === "owner" && link.ownerUserId && link.ownerUserId !== identity.userId))) {
      if (workspaceId) return null;
      continue;
    }
    const shared = link?.confirmed && link.state === "active" && link.settings.scope.calendar !== false;
    if (link?.role === "member") {
      if (!shared) { if (workspaceId) return null; continue; }
      if (workspaceId) projectId = link.projectId;
      continue;
    }
    if (workspaceId && shared) projectId = link.projectId;
    // Shared items come from the live platform. Only privately held data needs a snapshot.
    const items = shared && link.settings.scope.tasks ? [] : (await calendarExportItems(config, workspace, true))
      .filter(item => !shared || item.uid.startsWith("task-"));
    const name = workspace.displayName?.trim() || workspace.name;
    entries.push({ projectId: link?.confirmed && link.state === "active" ? link.projectId : null, name, items: items.map(item => subscriptionItem(item, workspaceId ? null : name)) });
  }
  if (!workspaceId) entries.push({ projectId: null, name: "Inbox", items: (await calendarExportItems(config, undefined, true)).map(item => subscriptionItem(item, "Inbox")) });
  return { projectId, snapshot: { scope: workspaceId ? "project" : "all", entries } };
}

function subscriptionItem(item: CalendarItem, projectName: string | null): CalendarItem {
  const calendar = parseCalendar(item.ical);
  for (const component of calendar.getAllSubcomponents()) {
    component.removeAllProperties("attach");
    if (projectName && component.name !== "vtimezone") component.updatePropertyWithValue("summary", `${projectName} · ${String(component.getFirstPropertyValue("summary") ?? item.title)}`);
  }
  return { ...item, attachmentPaths: [], sessionIds: [], taskIds: [], ical: serializeCalendar(calendar) };
}

async function request(ctx: Context, method: string, body?: unknown) {
  try { return await intakeRequest(ctx.client, method, "/api/calendar/feeds", body); }
  catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.code === "intake_redirected")) throw new ApiError(503, "calendar_subscription_unavailable", "Calendar subscriptions are not available on this server yet. Please try again after the server is updated.");
    throw error;
  }
}
const publicUrl = (ctx: Context, token: string) => `${ctx.client.platformURL.replace(/\/$/, "")}/api/calendar/feed/${token}`;

export async function calendarSubscription(config: ServerConfig, workspaceId: string | null) {
  const ctx = await context(config);
  if (!ctx) return { available: false, url: null, lastSyncedAt: null };
  const remote = FeedList.parse(await request(ctx, "GET")), store = await calendarStore(config);
  await checkAccount(config, ctx);
  const local = store.subscriptions(ctx.account).find(feed => feed.workspaceId === workspaceId);
  const feed = local ? remote.feeds.find(feed => feed.id === hash(local.token)) : null;
  if (local && !feed) store.removeSubscription(ctx.account, workspaceId);
  return { available: remote.entitled, url: local && feed ? publicUrl(ctx, local.token) : null, lastSyncedAt: feed?.updatedAt ?? null };
}

// A double click or two clients must not create orphan subscription credentials.
const changes = new Map<string, Promise<unknown>>();
export async function changeCalendarSubscription(config: ServerConfig, workspaceId: string | null, enable: boolean) {
  const ctx = await context(config);
  if (!ctx) throw new ApiError(403, "calendar_subscription_required", "Sign in with an active subscription to create a calendar link.");
  const key = JSON.stringify([config.configPath, ctx.account, workspaceId]);
  const change = (changes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const store = await calendarStore(config), local = store.subscriptions(ctx.account).find(feed => feed.workspaceId === workspaceId);
    if (!enable) {
      if (local) { await request(ctx, "DELETE", { token: local.token }); store.removeSubscription(ctx.account, workspaceId); }
      return calendarSubscription(config, workspaceId);
    }
    if (local) {
      const status = await calendarSubscription(config, workspaceId);
      if (status.url) return status;
    }
    const payload = await subscriptionPayload(config, ctx.identity, workspaceId);
    if (!payload) throw new ApiError(403, "calendar_not_shared", "This calendar is no longer available.");
    await checkAccount(config, ctx);
    const result = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await request(ctx, "POST", payload));
    store.saveSubscription(ctx.account, workspaceId, result.token, hash(JSON.stringify(payload)));
    await checkAccount(config, ctx);
    return { available: true, url: publicUrl(ctx, result.token), lastSyncedAt: new Date().toISOString() };
  });
  changes.set(key, change);
  try { return await change; } finally { if (changes.get(key) === change) changes.delete(key); }
}

/** Refresh private calendar snapshots in the existing project sync loop. */
export async function syncCalendarSubscriptions(config: ServerConfig) {
  const ctx = await context(config);
  if (!ctx) return;
  const store = await calendarStore(config), subscriptions = store.subscriptions(ctx.account);
  if (!subscriptions.length) return;
  const remote = FeedList.parse(await request(ctx, "GET"));
  for (const feed of subscriptions) {
    if (!remote.feeds.some(item => item.id === hash(feed.token))) { store.removeSubscription(ctx.account, feed.workspaceId); continue; }
    if (!remote.entitled) continue;
    const payload = await subscriptionPayload(config, ctx.identity, feed.workspaceId);
    await checkAccount(config, ctx);
    if (!payload) { await request(ctx, "DELETE", { token: feed.token }); store.removeSubscription(ctx.account, feed.workspaceId); continue; }
    const contentHash = hash(JSON.stringify(payload));
    if (contentHash === feed.contentHash) continue;
    await request(ctx, "PUT", { ...payload, token: feed.token });
    store.saveSubscription(ctx.account, feed.workspaceId, feed.token, contentHash);
  }
}
