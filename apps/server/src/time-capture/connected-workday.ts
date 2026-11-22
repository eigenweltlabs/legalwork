import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  captureProviders,
  captureAccountEnabled,
  type CaptureSettings,
  type CaptureAccount,
  type CaptureProposal,
} from "../back-office/timesheet-schema.js";
import { addDays, zonedInstant } from "../calendar/dates.js";
import { savedConnectorConnections } from "../connectors/broker.js";
import { nativePagePath } from "../connectors/native.js";
import { createConnectorRequest, type ConnectorRequest } from "../connectors/request.js";
import { connectorIsActivated } from "../connectors/settings.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { fileWorkdayEvidence } from "./file-workday.js";
import { observedPersonalDrive } from "./personal-drive-workday.js";
import { claimsFor, digest, type WorkdayEvidence } from "./private-workday.js";

type Account = CaptureAccount & { id: string; needsReconnect: boolean };
export async function connectedWorkdayAccounts(config: ServerConfig, includeUnavailable = false) {
  const result: Account[] = [];
  for (const provider of captureProviders) {
    // Use only the local connection registry while displaying source controls.
    const saved = await savedConnectorConnections(config, provider);
    for (const connection of saved) {
      if ((includeUnavailable || !connection.needsReconnect) && (await connectorIsActivated(config, provider, connection.id))) {
        result.push({ provider, account: digest([provider, connection.id]), id: connection.id, needsReconnect: connection.needsReconnect });
      }
    }
  }
  return result;
}

const pageSize = 50;
const entries = z.array(z.looseObject({ id: z.string() })).max(pageSize);
const googlePage = z.object({ items: entries.default([]), nextPageToken: z.string().optional() });
const gmailPage = z.object({ messages: entries.default([]), nextPageToken: z.string().optional() });
const graphPage = z.object({ value: entries, "@odata.nextLink": z.string().optional() });
const googleMessage = z.object({
  internalDate: z.string(), labelIds: z.array(z.string()), threadId: z.string().optional(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() }).optional(),
});
const googleDate = z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() });
// Google permits an offsetless local time with an explicit event time zone.
function googleInstant(time: string, zone: string) {
  const local = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d+)$/.exec(time);
  try {
    if (!local) return zonedInstant(time, zone);
    return new Date(Date.parse(zonedInstant(local[1], zone)) + Number(local[2].slice(0, 3).padEnd(3, "0"))).toISOString();
  } catch (error) {
    if (error instanceof ApiError && error.code === "ambiguous_calendar_time") return undefined;
    throw error;
  }
}
const graphDate = z.object({ dateTime: z.string() });
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const addr = (value: unknown) => z.object({ address: z.string() }).safeParse(value).data?.address.toLowerCase();

export async function accountWorkdayEvidence(
  account: CaptureAccount, date: string, zone: string, request: ConnectorRequest, signal: AbortSignal,
  onName?: (name: string) => void,
): Promise<WorkdayEvidence[]> {
  if (account.provider === "onedrive-personal") throw new ApiError(409, "workday_connection_cursor", "A personal drive needs its private change cursor.");
  if (account.provider === "google-drive" || account.provider === "onedrive" || account.provider === "sharepoint-files")
    return fileWorkdayEvidence(account, date, zone, request, signal, onName);
  const start = zonedInstant(date, zone), end = zonedInstant(addDays(date, 1), zone);
  const first = Date.parse(start), last = Date.parse(end);
  const items = new Map<string, WorkdayEvidence>();
  const microsoft = account.provider === "outlook" || account.provider === "outlook-calendar";
  const read = (path: string) => {
    signal.throwIfAborted();
    return request(path, { signal, ...(microsoft ? { headers: { Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' } } : {}) });
  };
  const accountName = (value: unknown) => {
    const email = z.email().max(320).safeParse(value);
    if (email.success) onName?.(email.data);
  };
  async function* pages(path: string, query: URLSearchParams, kind: "gmail" | "google" | "outlook", optionalShared = false) {
    const seen = new Set<string>();
    let next: string | undefined;
    do {
      const marker = next ?? "";
      if (seen.has(marker) || seen.size >= 100)
        throw new ApiError(409, "workday_connection_page_limit", "The provider returned too many pages for this day. Retry or exclude this source.");
      seen.add(marker);
      if (next && kind !== "outlook") query.set("pageToken", next);
      const page = await read(next && kind === "outlook" ? nativePagePath(next, "https://graph.microsoft.com", path) : path + "?" + query).catch(error => {
        // A listed shared calendar may expose free/busy only, or its invitation may have been revoked.
        if (optionalShared && error instanceof ApiError && (error.code === "connector_permission_required" || error.code === "connector_item_not_found")) return null;
        throw error;
      });
      if (page === null && optionalShared) return;
      if (kind === "outlook") {
        const result = graphPage.parse(page);
        next = result["@odata.nextLink"];
        yield result.value;
      } else if (kind === "gmail") {
        const result = gmailPage.parse(page);
        next = result.nextPageToken;
        yield result.messages;
      } else {
        const result = googlePage.parse(page);
        next = result.nextPageToken;
        yield result.items;
      }
    } while (next);
  }
  function append(id: string, subject: unknown, startAt: string | null, endAt: string | null, commonId?: string,
    mail?: { mailDirection: "sent" | "received"; observedAt: string; threadKey?: string }, observedAt?: string) {
    const eventKey = commonId ? digest(mail ? ["mail-message", commonId.trim().toLowerCase()] :
      ["meeting", commonId.toLowerCase(), startAt ?? observedAt ?? date]) : digest([account.provider, account.account, id, date]);
    const minutes = startAt && endAt ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000) : 0;
    const body = { date, source: account.provider, account: account.account, projectId: null, activity: mail ? "EML" : "EXM",
      narrative: string(subject)?.trim().slice(0, 2000) || (mail ? "Untitled email" : "Untitled calendar event"), startAt, endAt,
      ...(observedAt && { observedAt }), workedMinutes: !mail && minutes >= 1 && minutes <= 1440 ? minutes : null, ...mail };
    const item: WorkdayEvidence = { eventKey, proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]), dismissed: false } };
    if (commonId) {
      const [wireClaim] = claimsFor(item);
      item.claims = [wireClaim, { ...wireClaim, observationStart: startAt ? Date.parse(startAt) : undefined,
        id: digest([mail ? "mail-provider-item" : "calendar-provider-item", account.provider, account.account, id, date]) }];
    }
    items.set(id, item);
  }
  function mail(id: string, title: unknown, time: number, direction: "sent" | "received", thread: unknown, messageId?: string) {
    if (!(time >= first && time < last)) return;
    append(id, title, null, null, messageId, { mailDirection: direction, observedAt: new Date(time).toISOString(),
      ...(typeof thread === "string" && thread ? { threadKey: digest([account.provider, account.account, thread]) } : {}) });
  }
  function meeting(id: string, title: unknown, from?: string, to?: string, uid?: string) {
    if (!from || !to) return;
    const lo = Math.max(first, Date.parse(from)), hi = Math.min(last, Date.parse(to));
    if (hi > lo) append(id, title, new Date(lo).toISOString(), new Date(hi).toISOString(), uid);
  }
  if (account.provider === "gmail") {
    if (onName) {
      const identity = await read("/gmail/v1/users/me/profile?fields=emailAddress").catch(() => null);
      accountName(z.object({ emailAddress: z.string() }).safeParse(identity).data?.emailAddress);
    }
    const path = "/gmail/v1/users/me/messages";
    const query = new URLSearchParams({ q: `after:${Math.floor(first / 1000) - 1} before:${Math.ceil(last / 1000)} -in:drafts -in:spam -in:trash`,
      maxResults: String(pageSize), fields: "messages(id),nextPageToken" });
    for await (const page of pages(path, query, "gmail")) {
      for (let i = 0; i < page.length; i += 5) {
        await Promise.all(page.slice(i, i + 5).map(async ({ id }) => {
          const fields = new URLSearchParams({ format: "metadata", fields: "internalDate,labelIds,threadId,payload(headers)" });
          fields.append("metadataHeaders", "Subject");
          fields.append("metadataHeaders", "Message-ID");
          const message = await read(path + "/" + encodeURIComponent(id) + "?" + fields).catch(error => {
            if (error instanceof ApiError && error.code === "connector_item_not_found") return null;
            throw error;
          });
          if (!message) return;
          const data = googleMessage.parse(message);
          if (data.labelIds.some(label => ["DRAFT", "SPAM", "TRASH", "SCHEDULED"].includes(label))) return;
          const header = (key: string) => data.payload?.headers?.find(h => h.name.toLowerCase() === key)?.value;
          mail(id, header("subject"), Number(data.internalDate), data.labelIds.includes("SENT") ? "sent" : "received", data.threadId, header("message-id"));
        }));
      }
    }
  } else if (account.provider === "outlook") {
    const identity = z.object({ mail: z.string().nullish(), userPrincipalName: z.string().nullish() }).parse(await read("/v1.0/me?$select=mail,userPrincipalName"));
    accountName(identity.mail ?? identity.userPrincipalName);
    const addresses = [identity.mail, identity.userPrincipalName].flatMap(value => value ? [value.toLowerCase()] : []);
    const folders = await Promise.all(["sentitems", "junkemail", "deleteditems", "outbox"].map(async folder =>
      z.object({ id: z.string() }).parse(await read("/v1.0/me/mailFolders/" + folder + "?$select=id")).id));
    const excluded = new Set(folders.slice(1));
    const query = new URLSearchParams({ $top: String(pageSize),
      $filter: `(receivedDateTime ge ${start} and receivedDateTime lt ${end}) or (sentDateTime ge ${start} and sentDateTime lt ${end})`,
      $select: "id,subject,parentFolderId,sender,isDraft,sentDateTime,receivedDateTime,conversationId,internetMessageId" });
    for await (const page of pages("/v1.0/me/messages", query, "outlook")) {
      for (const item of page) {
        if (item.isDraft || excluded.has(string(item.parentFolderId) ?? "")) continue;
        const sender = z.object({ emailAddress: z.object({ address: z.string() }) }).safeParse(item.sender).data;
        const sent = item.parentFolderId === folders[0] || !!sender && addresses.includes(sender.emailAddress.address.toLowerCase());
        mail(item.id, item.subject, Date.parse(string(sent ? item.sentDateTime : item.receivedDateTime) ?? ""),
          sent ? "sent" : "received", item.conversationId, string(item.internetMessageId));
      }
    }
  } else if (account.provider === "google-calendar") {
    const list = new URLSearchParams({ maxResults: String(pageSize), minAccessRole: "reader", fields: "items(id,primary,accessRole),nextPageToken" });
    const calendars = new Map([["primary", true]]);
    let address: string | undefined;
    for await (const page of pages("/calendar/v3/users/me/calendarList", list, "google")) {
      for (const calendar of page) {
        if (calendar.primary) {
          address = z.email().safeParse(calendar.id).data?.toLowerCase();
          accountName(address);
        } else if (calendar.accessRole !== "freeBusyReader") calendars.set(calendar.id, calendar.accessRole === "owner");
      }
    }
    for (const [calendar, owned] of calendars) {
      if (!owned && !address) continue;
      const query = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: "true", showDeleted: "false", maxResults: String(pageSize),
        fields: `items(id,iCalUID,status,eventType,endTimeUnspecified,attendees(self,responseStatus${calendar === "primary" ? "" : ",email"})${owned ? "" : ",organizer(email)"},summary,start,end),nextPageToken` });
      for await (const page of pages("/calendar/v3/calendars/" + encodeURIComponent(calendar) + "/events", query, "google", !owned)) {
        for (const event of page) {
          const attendance = z.array(z.object({ email: z.string().optional(), self: z.boolean().optional(), responseStatus: z.string().optional() })).optional().parse(event.attendees);
          const ownAttendance = attendance?.find(person => calendar === "primary" ? person.self : Boolean(address && person.email?.toLowerCase() === address));
          const organizer = z.object({ email: z.string().optional() }).safeParse(event.organizer).data?.email?.toLowerCase();
          if (!owned && !ownAttendance && organizer !== address) continue;
          if (event.status === "cancelled" || ["outOfOffice", "workingLocation", "birthday"].includes(string(event.eventType) ?? "") ||
              ownAttendance?.responseStatus === "declined") continue;
          const from = googleDate.parse(event.start), to = googleDate.parse(event.end), uid = string(event.iCalUID);
          const id = calendar === "primary" ? event.id : calendar + "/" + event.id;
          if (from.date) {
            if (from.date <= date && (!to.date || date < to.date)) append(id, event.summary, null, null, uid);
          } else if (from.dateTime) {
            const eventZone = from.timeZone ?? zone;
            const fromAt = googleInstant(from.dateTime, eventZone);
            // An offsetless DST gap or fold gives no reliable clock. Keep known same-zone day context.
            if (!fromAt) {
              if (eventZone === zone && from.dateTime.startsWith(date + "T")) append(id, event.summary, null, null, uid);
              continue;
            }
            // Google supplies a compatibility end even when the worker never specified one.
            const toAt = !event.endTimeUnspecified && to.dateTime ? googleInstant(to.dateTime, to.timeZone ?? eventZone) : undefined;
            if (toAt) meeting(id, event.summary, fromAt, toAt, uid);
            else if (fromAt >= start && fromAt < end) append(id, event.summary, null, null, uid, undefined, fromAt);
          }
        }
      }
    }
  } else {
    const list = new URLSearchParams({ $top: String(pageSize), $select: "id,isDefaultCalendar,owner" });
    const calendars: { id: string; owner?: string; primary: boolean }[] = [];
    for await (const page of pages("/v1.0/me/calendars", list, "outlook"))
      for (const calendar of page) calendars.push({ id: calendar.id, owner: addr(calendar.owner), primary: calendar.isDefaultCalendar === true });
    const primary = calendars.find(calendar => calendar.primary);
    accountName(primary?.owner);
    const paths = [{ path: "/v1.0/me/calendar/calendarView", owned: true }, ...calendars.filter(calendar => !calendar.primary && primary?.owner)
      .map(calendar => ({ path: "/v1.0/me/calendars/" + encodeURIComponent(calendar.id) + "/calendarView", owned: calendar.owner === primary?.owner }))];
    for (const { path, owned } of paths) {
      const query = new URLSearchParams({ $top: String(pageSize), startDateTime: start, endDateTime: end,
        $select: "id,iCalUId,subject,start,end,isAllDay,isCancelled,responseStatus,showAs" + (owned ? "" : ",organizer,attendees") });
      for await (const page of pages(path, query, "outlook", !owned)) {
        for (const item of page) {
          const response = z.object({ response: z.string().optional() }).nullish().parse(item.responseStatus);
          if (!owned) {
            const participant = z.object({ emailAddress: z.unknown(), status: z.object({ response: z.string().optional() }).optional() });
            const attendee = z.array(participant).optional().parse(item.attendees)?.find(person => addr(person.emailAddress) === primary?.owner);
            const organizer = participant.safeParse(item.organizer).data;
            if (attendee?.status?.response === "declined" || (!attendee && (!organizer || addr(organizer.emailAddress) !== primary?.owner))) continue;
          }
          if (item.isCancelled || item.showAs === "oof" || (owned && response?.response === "declined")) continue;
          const from = graphDate.parse(item.start).dateTime, to = graphDate.parse(item.end).dateTime, uid = string(item.iCalUId);
          const utc = (value: string) => /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z";
          if (item.isAllDay) {
            if (Date.parse(utc(from)) < last && Date.parse(utc(to)) > first) append(item.id, item.subject, null, null, uid);
          } else meeting(item.id, item.subject, utc(from), utc(to), uid);
        }
      }
    }
  }
  return [...items.values()];
}

export async function readConnectedWorkday(
  config: ServerConfig,
  settings: CaptureSettings,
  date: string,
  signal: AbortSignal,
  observers?: { onFailed: (account: CaptureAccount, error: string) => void; onName: (account: CaptureAccount, name: string) => void; onRead: (account: CaptureAccount) => void },
) {
  if (settings.connections?.length === 0) return [];
  const available = await connectedWorkdayAccounts(config, true),
    output: WorkdayEvidence[] = [];
  await Promise.all(available.filter(item => captureAccountEnabled(settings, item)).map(async account => {
    try {
      signal.throwIfAborted();
      if (account.needsReconnect) throw new ApiError(409, "connector_reconnect_required", "Reconnect this account in Integrations.");
      const accountSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
      const request = await createConnectorRequest(config, account.provider, account.id);
      const name = observers ? (name: string) => observers.onName(account, name) : undefined;
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const rows = account.provider === "onedrive-personal"
        ? await observedPersonalDrive(config, account, date, zone, request, accountSignal, name)
        : await accountWorkdayEvidence(account, date, zone, request, accountSignal, name);
      output.push(...rows);
      observers?.onRead(account);
    } catch (e) {
      if (signal.aborted) throw e;
      if (observers) observers.onFailed(account, e instanceof ApiError ? e.code : "workday_connection_error");
      else throw e;
    }
  }));
  return output;
}

export function sourceAvailable(
  proposal: Pick<CaptureProposal, "source" | "account">,
  accounts: CaptureAccount[],
  settings: Omit<CaptureSettings, "intervalMinutes">,
) {
  if (proposal.source === "stopwatch") return true;
  if (proposal.source === "recordings") return settings.recordings === true;
  if (proposal.source === "desktop") return settings.desktopActivity === true;
  if (proposal.source === "documents") return settings.documents === true;
  if (proposal.source === "workspace" || proposal.source === "agent") return settings.workspaceActivity !== false;
  if (proposal.source === "calendar" || proposal.source === "tasks") return settings[proposal.source];
  const target = { provider: proposal.source, account: proposal.account };
  return accounts.some(
    (selected) =>
      selected.provider === target.provider &&
      selected.account === target.account &&
      captureAccountEnabled(settings, selected),
  );
}
