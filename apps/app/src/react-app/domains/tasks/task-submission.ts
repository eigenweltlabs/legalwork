/**
 * Reader for the submission a task was triaged from.
 *
 * `GET /intake/tasks/:id` relays `{ task, submission }` and the wire contract
 * deliberately does not pin the submission shape — `rawPayload` is whatever the
 * inbound relay (Brevo) or the API caller sent. So nothing here trusts a key to
 * exist: every field is probed, and a payload we cannot read at all degrades to
 * "no original message" instead of throwing inside the detail view.
 */

export type TaskSubmissionView = {
  /** Sender as displayed: the parsed address, or whatever the payload names. */
  from: string | null;
  to: string | null;
  subject: string | null;
  /** Plain-text body, when the payload carries one. */
  text: string | null;
  /** HTML body, still UNSANITIZED — the renderer sanitizes before display. */
  html: string | null;
  /** ISO timestamp the submission was received, when known. */
  receivedAt: string | null;
  /** "email" | "api" per the contract; any other value is passed through. */
  channel: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * An address is a bare string in our own API ingest and an object in most
 * inbound-parse payloads (`{ Address, Name }` / `{ address, name }`); a `To`
 * field is often a list of those.
 */
function readAddress(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    const resolved = addressToString(value);
    if (resolved) return resolved;
  }
  return null;
}

function addressToString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map(addressToString).filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join(", ") : null;
  }
  if (isRecord(value)) {
    const address = readString(value, ["address", "Address", "email", "Email"]);
    const name = readString(value, ["name", "Name"]);
    if (address && name) return `${name} <${address}>`;
    return address ?? name;
  }
  return null;
}

/**
 * Inbound mail is stored as `{ provider, item }`, the relay's own item, so its
 * fields (`From`, `To`, `Subject`, `RawTextBody`, …) sit one level down. The
 * API channel stores its fields flat and carries neither key.
 */
function unwrapInboundEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  return typeof payload.provider === "string" && isRecord(payload.item) ? payload.item : payload;
}

/**
 * Normalize `{ task, submission }`'s submission half into something renderable.
 * Accepts both the wrapper (`{ rawPayload, senderEmail, … }`) and a bare raw
 * payload, because only the wrapper's existence is pinned by the contract.
 */
export function readTaskSubmission(submission: unknown): TaskSubmissionView | null {
  if (!isRecord(submission)) return null;
  const rawPayload = unwrapInboundEnvelope(
    isRecord(submission.rawPayload) ? submission.rawPayload : submission,
  );

  const view: TaskSubmissionView = {
    from:
      readAddress(rawPayload, ["from", "From", "sender", "Sender", "submitter"]) ??
      readString(submission, ["senderEmail"]),
    to: readAddress(rawPayload, ["to", "To", "recipient", "Recipient"]),
    subject: readString(rawPayload, ["subject", "Subject"]),
    text: readString(rawPayload, ["text", "Text", "RawTextBody", "TextBody", "body", "description"]),
    html: readString(rawPayload, ["html", "Html", "RawHtmlBody", "HtmlBody"]),
    receivedAt:
      readString(submission, ["receivedAt", "received_at"]) ??
      readString(rawPayload, ["date", "Date", "receivedAt"]),
    channel: readString(submission, ["channel"]),
  };

  const hasContent = Boolean(view.from || view.subject || view.text || view.html);
  return hasContent ? view : null;
}
