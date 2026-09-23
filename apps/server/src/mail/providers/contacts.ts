import { z } from "zod";
import { mailAddressSchema } from "../local-view.js";
export type ContactChange = {
  id: string;
  name?: string;
  addresses?: string[];
  deleted: boolean;
};
export type ContactSnapshot = {
  changes: ContactChange[];
  cursor: string | null;
  full: boolean;
};
export class ContactsError extends Error {
  constructor(
    readonly code:
      "permission" | "unavailable" | "limit" | "invalid_response" | "expired",
  ) {
    super("mail_contacts_" + code);
  }
}
const token = z.string().min(1).max(16384),
  id = z.string().min(1).max(4096);
const text = z.string().max(16384);
const person = z.object({
  resourceName: id,
  metadata: z.object({ deleted: z.boolean().optional() }).optional(),
  names: z
    .array(z.object({ displayName: text.optional() }))
    .max(100)
    .optional(),
  emailAddresses: z
    .array(z.object({ value: text.optional() }))
    .max(100)
    .optional(),
});
const contact = z.object({
  id,
  displayName: text.nullable().optional(),
  emailAddresses: z
    .array(z.object({ address: text.nullable().optional() }))
    .max(100)
    .optional(),
  "@removed": z.object({ reason: z.string().optional() }).optional(),
});
const cleanName = (name: string) =>
  name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256);
const emails = (values: (string | null | undefined)[]) => [
  ...new Set(
    values.flatMap((value) => {
      const parsed = mailAddressSchema.safeParse(value?.trim());
      return parsed.success ? [parsed.data] : [];
    }),
  ),
];
/** Follow only the selected personal collection, never an arbitrary provider nextLink. */
export function contactGraphUrl(value: string, path: string): string {
  if (!value.startsWith("https://graph.microsoft.com/") || /[\\\s]/.test(value))
    throw new ContactsError("invalid_response");
  const url = new URL(value);
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.pathname.toLowerCase() !== path.toLowerCase() ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ContactsError("invalid_response");
  return value;
}
export async function fetchContactSnapshot(input: {
  provider: "gmail" | "graph";
  accessToken: string;
  cursor: string | null;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<ContactSnapshot> {
  const request = async (url: string): Promise<unknown> => {
    const response = await (input.fetch ?? fetch)(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/json",
        Prefer: "odata.maxpagesize=100",
      },
      signal: input.signal,
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403)
      throw new ContactsError("permission");
    if (response.status === 410) throw new ContactsError("expired");
    const reader = response.body?.getReader();
    if (!reader) throw new ContactsError("invalid_response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new ContactsError("limit");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ContactsError("invalid_response");
    }
    if (!response.ok) {
      const expired = z
        .object({
          error: z.object({
            details: z
              .array(z.object({ reason: z.string().optional() }))
              .optional(),
          }),
        })
        .safeParse(data);
      if (
        input.provider === "gmail" &&
        expired.success &&
        expired.data.error.details?.some(
          (detail) => detail.reason === "EXPIRED_SYNC_TOKEN",
        )
      )
        throw new ContactsError("expired");
      throw new ContactsError("unavailable");
    }
    return data;
  };
  const run = async (cursor: string | null): Promise<ContactSnapshot> => {
    const changes: ContactChange[] = [];
    let next: string | null = null;
    const seen = new Set<string>();
    let graphPath = "";
    if (input.provider === "graph") {
      if (cursor) {
        const match = new URL(cursor).pathname.match(
          /^\/v1\.0\/me\/contactFolders\/[^/]+\/contacts\/delta$/i,
        );
        if (!match) throw new ContactsError("invalid_response");
        graphPath = match[0];
        next = contactGraphUrl(cursor, graphPath);
      } else {
        // /me/contacts is the documented default personal folder. Its parentFolderId
        // selects the documented folder delta endpoint without guessing a folder name.
        const probe = z
          .object({ value: z.array(z.object({ parentFolderId: id })).max(1) })
          .parse(
            await request(
              "https://graph.microsoft.com/v1.0/me/contacts?$top=1&$select=parentFolderId",
            ),
          );
        if (!probe.value.length)
          return { changes: [], cursor: null, full: true };
        graphPath = `/v1.0/me/contactFolders/${encodeURIComponent(probe.value[0].parentFolderId)}/contacts/delta`;
        next = `https://graph.microsoft.com${graphPath}?$select=id,displayName,emailAddresses`;
      }
    }
    for (let page = 0; page < 200; page++) {
      input.signal.throwIfAborted();
      let url: string;
      if (input.provider === "gmail") {
        const endpoint = new URL(
          "https://people.googleapis.com/v1/people/me/connections",
        );
        endpoint.searchParams.set(
          "personFields",
          "names,emailAddresses,metadata",
        );
        endpoint.searchParams.set("sources", "READ_SOURCE_TYPE_CONTACT");
        endpoint.searchParams.set("pageSize", "1000");
        endpoint.searchParams.set("requestSyncToken", "true");
        if (cursor) endpoint.searchParams.set("syncToken", cursor);
        if (next) endpoint.searchParams.set("pageToken", next);
        url = endpoint.toString();
      } else {
        if (!next) throw new ContactsError("invalid_response");
        url = contactGraphUrl(next, graphPath);
      }
      if (seen.has(url)) throw new ContactsError("invalid_response");
      seen.add(url);
      const raw = await request(url);
      let final: string | undefined;
      if (input.provider === "gmail") {
        const data = z
          .object({
            connections: z.array(person).max(1000).optional(),
            nextPageToken: token.optional(),
            nextSyncToken: token.optional(),
          })
          .parse(raw);
        changes.push(
          ...(data.connections ?? []).map((value) => ({
            id: value.resourceName,
            name: cleanName(value.names?.[0]?.displayName ?? ""),
            addresses: emails(
              (value.emailAddresses ?? []).map((email) => email.value),
            ),
            deleted: value.metadata?.deleted === true,
          })),
        );
        next = data.nextPageToken ?? null;
        final = data.nextSyncToken;
      } else {
        const data = z
          .object({
            value: z.array(contact).max(1000),
            "@odata.nextLink": token.optional(),
            "@odata.deltaLink": token.optional(),
          })
          .parse(raw);
        changes.push(
          ...data.value.map((value) => ({
            id: value.id,
            ...(value.displayName !== undefined
              ? { name: cleanName(value.displayName ?? "") }
              : {}),
            ...(value.emailAddresses !== undefined
              ? {
                  addresses: emails(
                    value.emailAddresses.map((email) => email.address),
                  ),
                }
              : {}),
            deleted: !!value["@removed"],
          })),
        );
        next = data["@odata.nextLink"]
          ? contactGraphUrl(data["@odata.nextLink"], graphPath)
          : null;
        final = data["@odata.deltaLink"]
          ? contactGraphUrl(data["@odata.deltaLink"], graphPath)
          : undefined;
      }
      if (changes.length > 20000) throw new ContactsError("limit");
      if (!next) {
        if (!final) throw new ContactsError("invalid_response");
        return { changes, cursor: final, full: cursor === null };
      }
      if (final) throw new ContactsError("invalid_response");
    }
    throw new ContactsError("limit");
  };
  try {
    return await run(input.cursor);
  } catch (error) {
    if (
      error instanceof ContactsError &&
      error.code === "expired" &&
      input.cursor
    )
      return run(null);
    if (error instanceof z.ZodError)
      throw new ContactsError("invalid_response");
    throw error;
  }
}
