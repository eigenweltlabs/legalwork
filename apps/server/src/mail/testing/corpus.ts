import { createHash } from "node:crypto";

export type FixtureKind = "plain" | "duplicate-id" | "missing-id" | "other-account" | "gmail-labels" | "old-nested" | "german" | "multipart" | "malformed" | "large";
export interface SyntheticMessage {
  accountId: string;
  sourceId: string;
  kind: FixtureKind;
  messageId: string | null;
  memberships: string[];
  /** Fresh, bounded chunks on each call. Never concatenate for large fixtures. */
  chunks(): Iterable<Uint8Array>;
}
export interface ContentManifest {
  version: 1;
  accountId: string;
  sourceId: string;
  kind: FixtureKind;
  messageId: string | null;
  memberships: string[];
  bytes: number;
  sha256: string;
}
const kinds: FixtureKind[] = ["plain", "duplicate-id", "missing-id", "other-account", "gmail-labels", "old-nested", "german", "multipart", "malformed", "large"];
const encoder = new TextEncoder();
const wire = (lines: string[]) => encoder.encode(lines.join("\r\n") + "\r\n");

/** Index and options fully determine bytes; no clock, RNG, network or private data. */
export function fixture(index: number, largeAttachmentBytes = 8 * 1024 * 1024): SyntheticMessage {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("index must be a nonnegative safe integer");
  if (!Number.isSafeInteger(largeAttachmentBytes) || largeAttachmentBytes < 0) throw new RangeError("attachment bytes must be a nonnegative safe integer");
  const kind = kinds[index % kinds.length]!;
  const group = Math.floor(index / kinds.length);
  const accountId = kind === "other-account" ? "synthetic-b" : "synthetic-a";
  // Duplicate RFC IDs within an account AND source IDs across account namespaces.
  const sourceId = `message-${kind === "other-account" ? index - 3 : index}`;
  const messageId = kind === "missing-id" ? null : `<fixture-${kind === "duplicate-id" || kind === "other-account" ? group * 10 : index}@example.invalid>`;
  const memberships = kind === "gmail-labels" ? ["INBOX", "Label_Contracts", "Label_Urgent"] : kind === "old-nested" ? ["Archive/2001/Mandate/Verträge"] : ["INBOX"];
  return { accountId, sourceId, kind, messageId, memberships, *chunks() {
    const boundary = `synthetic-boundary-${index}`;
    const multipart = kind === "multipart" || kind === "large" || kind === "malformed";
    yield wire([
      "From: =?UTF-8?B?SsO8cmdlbiBNw7xsbGVy?= <sender@example.invalid>",
      "To: recipient@example.invalid",
      ...(messageId ? [`Message-ID: ${messageId}`] : []),
      `Date: ${kind === "old-nested" ? "Mon, 1 Jan 2001" : "Thu, 1 Jan 2026"} 12:00:00 +0000`,
      `Subject: ${kind === "german" ? "=?UTF-8?B?UHLDvGZ1bmcgZGVyIFZlcnRyw6RnZQ==?=" : `Synthetic matter ${index}`}`,
      "MIME-Version: 1.0",
      `Content-Type: ${multipart ? `multipart/mixed; boundary="${boundary}"` : "text/plain; charset=utf-8"}`,
      ...(multipart ? [] : ["Content-Transfer-Encoding: 8bit"]), "",
    ]);
    if (!multipart) { yield wire([`Synthetic message ${index}. Prüfung: Größe, Kündigung, § 123 BGB.`]); return; }
    yield wire([`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", "Synthetic multipart matter."]);
    if (kind === "malformed") {
      yield wire([`--${boundary}`, "Content-Type: application/octet-stream", "Content-Transfer-Encoding: base64", "", "!!! invalid base64 !!!"]);
      return; // Deliberately invalid encoding and absent closing boundary.
    }
    if (kind === "multipart") {
      yield wire([`--${boundary}`, "Content-Type: multipart/related; boundary=related", "", "--related", "Content-Type: text/html; charset=utf-8", "", '<p>Prüfung <img src="cid:pixel@example.invalid"></p>', "--related", "Content-Type: image/png", "Content-ID: <pixel@example.invalid>", 'Content-Disposition: inline; filename="pixel.png"', "Content-Transfer-Encoding: base64", "", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "--related--",
        `--${boundary}`, "Content-Type: message/rfc822", "Content-Disposition: attachment", "", "From: embedded@example.invalid", "To: recipient@example.invalid", "Subject: Embedded synthetic message", "Message-ID: <embedded@example.invalid>", "Content-Type: text/plain; charset=utf-8", "", "Embedded evidence.",
        `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Disposition: attachment; filename*=UTF-8''Pr%C3%BCfung.txt", "Content-Transfer-Encoding: base64", "", "UHLDvGZ1bmcNCg=="]);
    } else {
      yield wire([`--${boundary}`, "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="generated.bin"', "Content-Transfer-Encoding: base64", ""]);
      // 57 raw bytes => one RFC-compliant 76-character base64 line.
      // Batch up to 512 lines (~40 KiB), regardless of attachment size.
      let offset = 0;
      while (offset < largeAttachmentBytes) {
        const lines: string[] = [];
        for (let line = 0; line < 512 && offset < largeAttachmentBytes; line++) {
          const raw = Buffer.alloc(Math.min(57, largeAttachmentBytes - offset));
          for (let byte = 0; byte < raw.length; byte++) raw[byte] = (offset + byte) % 251;
          offset += raw.length;
          lines.push(raw.toString("base64"));
        }
        yield wire(lines);
      }
    }
    yield wire([`--${boundary}--`]);
  } };
}

/** Only one descriptor is produced at a time; MIME is generated only when chunks are read. */
export function* corpus(count = 10, largeAttachmentBytes = 8 * 1024 * 1024): Iterable<SyntheticMessage> {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("count must be a nonnegative safe integer");
  for (let index = 0; index < count; index++) yield fixture(index, largeAttachmentBytes);
}

/** Sink is awaited for every chunk, providing backpressure without buffering MIME. */
export async function consume(message: SyntheticMessage, sink?: (chunk: Uint8Array) => Promise<void>): Promise<ContentManifest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const chunk of message.chunks()) {
    if (sink) await sink(chunk);
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { version: 1, accountId: message.accountId, sourceId: message.sourceId, kind: message.kind, messageId: message.messageId, memberships: [...message.memberships], bytes, sha256: hash.digest("hex") };
}
