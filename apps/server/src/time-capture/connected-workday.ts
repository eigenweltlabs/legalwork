import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  captureProviders,
  sameCaptureAccount,
  type CaptureAccount,
  type CaptureProposal,
} from "@legalwork/types/time-capture";
import { addDays, zonedInstant } from "../calendar/dates.js";
import { savedConnectorConnections } from "../connectors/broker.js";
import { nativePagePath } from "../connectors/native.js";
import { createConnectorRequest, type ConnectorRequest } from "../connectors/request.js";
import { connectorIsActivated } from "../connectors/settings.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { digest, type WorkdayEvidence } from "./private-workday.js";

type Account = CaptureAccount & { id: string };
export async function connectedWorkdayAccounts(config: ServerConfig) {
  const result: Account[] = [];
  for (const provider of captureProviders) {
    // Use only the local connection registry while displaying source controls.
    const saved = await savedConnectorConnections(config, provider);
    for (const connection of saved) {
      if (!connection.needsReconnect && (await connectorIsActivated(config, provider, connection.id))) {
        result.push({ provider, account: digest([provider, connection.id]), id: connection.id });
      }
    }
  }
  return result;
}

const pages = 10;
const limit = 50;
const providerError = () =>
  new ApiError(
    502,
    "workday_connection_error",
    "A selected workday source could not be read. Check the connection and retry.",
  );
const entries = z.array(z.looseObject({ id: z.string() })).max(limit);
const googlePage = z.object({ items: entries.default([]), nextPageToken: z.string().optional() });
const gmailPage = z.object({ messages: entries.default([]), nextPageToken: z.string().optional() });
const graphPage = z.object({ value: entries, "@odata.nextLink": z.string().optional() });
const googleMessage = z.object({
  internalDate: z.string(),
  payload: z
    .object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() })
    .optional(),
});
const googleDate = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const graphDate = z.object({ dateTime: z.string() });

export async function accountWorkdayEvidence(
  account: CaptureAccount,
  date: string,
  zone: string,
  request: ConnectorRequest,
  signal: AbortSignal,
): Promise<WorkdayEvidence[]> {
  const start = zonedInstant(date, zone),
    end = zonedInstant(addDays(date, 1), zone);
  const first = Date.parse(start),
    last = Date.parse(end);
  const items = new Map<string, WorkdayEvidence>();
  const mail = account.provider === "gmail" || account.provider === "outlook";
  const microsoft = account.provider === "outlook" || account.provider === "outlook-calendar";
  const path =
    account.provider === "gmail"
      ? "/gmail/v1/users/me/messages"
      : account.provider === "outlook"
        ? "/v1.0/me/mailFolders/sentitems/messages"
        : account.provider === "google-calendar"
          ? "/calendar/v3/calendars/primary/events"
          : "/v1.0/me/calendar/calendarView";
  const requestPage = async (path: string) => {
    signal.throwIfAborted();
    return request(path, {
      signal,
      ...(microsoft ? { headers: { Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' } } : {}),
    });
  };
  const append = (
    id: string,
    subject: unknown,
    startAt: string | null,
    endAt: string | null,
    uid?: string,
  ) => {
    if (typeof subject !== "string" || !subject.trim()) return;
    const eventKey =
      uid && !mail
        ? digest(["meeting", uid.toLowerCase(), startAt ?? date])
        : digest([account.provider, account.account, id, date]);
    const minutes = startAt && endAt ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000) : 0;
    const body = {
      date,
      source: account.provider,
      account: account.account,
      projectId: null,
      activity: mail ? "EML" : "EXM",
      narrative: subject.trim().slice(0, 2000),
      startAt,
      endAt,
      workedMinutes: !mail && minutes >= 1 && minutes <= 1440 ? minutes : null,
    };
    items.set(eventKey, {
      eventKey,
      proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]), dismissed: false },
    });
  };
  let next: string | undefined;
  const seen = new Set<string>();
  do {
    const marker = next ?? "";
    if (seen.has(marker) || seen.size >= pages)
      throw new ApiError(
        409,
        "workday_connection_page_limit",
        "This source exceeds 500 items for this day. Record the entries manually or disable this source and retry.",
      );
    seen.add(marker);
    if (account.provider === "gmail") {
      // Gmail date predicates have second precision and exclude the boundary; filter again by the exact local day.
      const query = new URLSearchParams({
        labelIds: "SENT",
        q: `after:${Math.floor(first / 1000) - 1} before:${Math.ceil(last / 1000)}`,
        maxResults: String(limit),
        fields: "messages(id),nextPageToken",
      });
      if (next) query.set("pageToken", next);
      const page = gmailPage.parse(await requestPage(path + "?" + query));
      for (const message of page.messages) {
        const data = googleMessage.parse(
          await requestPage(
            path +
              "/" +
              encodeURIComponent(message.id) +
              "?format=metadata&metadataHeaders=Subject&fields=internalDate,payload(headers)",
          ),
        );
        const at = Number(data.internalDate);
        if (at >= first && at < last)
          append(
            message.id,
            data.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value,
            null,
            null,
          );
      }
      next = page.nextPageToken;
    } else if (account.provider === "google-calendar") {
      const query = new URLSearchParams({
        timeMin: start,
        timeMax: end,
        singleEvents: "true",
        showDeleted: "false",
        maxResults: String(limit),
        fields: "items(id,iCalUID,status,summary,start,end),nextPageToken",
      });
      if (next) query.set("pageToken", next);
      const page = googlePage.parse(await requestPage(path + "?" + query));
      for (const event of page.items) {
        if (event.status === "cancelled") continue;
        const from = googleDate.parse(event.start),
          to = googleDate.parse(event.end);
        const uid = typeof event.iCalUID === "string" ? event.iCalUID : undefined;
        if (from.date) {
          if (from.date === date) append(event.id, event.summary, null, null, uid);
          continue;
        }
        addMeeting(event.id, event.summary, from.dateTime, to.dateTime, uid);
      }
      next = page.nextPageToken;
    } else {
      const query = new URLSearchParams({ $top: String(limit) });
      if (mail) {
        query.set("$filter", `sentDateTime ge ${start} and sentDateTime lt ${end}`);
        query.set("$select", "id,subject,sentDateTime,isDraft");
      } else {
        query.set("startDateTime", start);
        query.set("endDateTime", end);
        query.set("$select", "id,iCalUId,subject,start,end,isAllDay,isCancelled");
      }
      const page = graphPage.parse(
        await requestPage(
          next ? nativePagePath(next, "https://graph.microsoft.com", path) : path + "?" + query,
        ),
      );
      for (const item of page.value) {
        if (mail) {
          const sent = typeof item.sentDateTime === "string" ? Date.parse(item.sentDateTime) : NaN;
          if (!item.isDraft && sent >= first && sent < last) append(item.id, item.subject, null, null);
        } else if (!item.isCancelled) {
          const from = graphDate.parse(item.start).dateTime,
            to = graphDate.parse(item.end).dateTime;
          const utc = (d: string) => (/Z$|[+-]\d\d:\d\d$/.test(d) ? d : d + "Z");
          const uid = typeof item.iCalUId === "string" ? item.iCalUId : undefined;
          if (item.isAllDay) {
            if (from.slice(0, 10) <= date && to.slice(0, 10) > date)
              append(item.id, item.subject, null, null, uid);
            continue;
          }
          addMeeting(item.id, item.subject, utc(from), utc(to), uid);
        }
      }
      next = page["@odata.nextLink"];
    }
  } while (next);
  return [...items.values()];

  function addMeeting(id: string, subject: unknown, from?: string, to?: string, uid?: string) {
    if (!from || !to) return;
    const lo = Math.max(first, Date.parse(from)),
      hi = Math.min(last, Date.parse(to));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    append(id, subject, new Date(lo).toISOString(), new Date(hi).toISOString(), uid);
  }
}
export async function readConnectedWorkday(
  config: ServerConfig,
  requested: CaptureAccount[],
  date: string,
  signal: AbortSignal,
) {
  if (!requested.length) return [];
  const available = await connectedWorkdayAccounts(config),
    output: WorkdayEvidence[] = [];
  for (const account of available.filter((item) =>
    requested.some((choice) => sameCaptureAccount(item, choice)),
  )) {
    try {
      signal.throwIfAborted();
      const request = await createConnectorRequest(config, account.provider, account.id);
      output.push(
        ...(await accountWorkdayEvidence(
          account,
          date,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
          request,
          signal,
        )),
      );
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof ApiError && e.code === "workday_connection_page_limit") throw e;
      throw providerError();
    }
  }
  return output;
}

export function sourceAvailable(
  proposal: CaptureProposal,
  accounts: CaptureAccount[],
  settings: { calendar: boolean; tasks: boolean; documents?: boolean; connections?: CaptureAccount[] },
) {
  if (proposal.source === "documents") return settings.documents === true;
  if (proposal.source === "calendar" || proposal.source === "tasks") return settings[proposal.source];
  const target = { provider: proposal.source, account: proposal.account };
  return accounts.some(
    (selected) =>
      selected.provider === target.provider &&
      selected.account === target.account &&
      settings.connections?.some((choice) => sameCaptureAccount(choice, selected)),
  );
}
