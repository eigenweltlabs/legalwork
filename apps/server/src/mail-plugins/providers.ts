import { z } from "zod";
import type { MailAction, MailOutgoing } from "@legalwork/types/mail-plugins";
import { ApiError } from "../errors.js";
import { mailJson } from "./http.js";
import type { SavedMailAccount } from "./vault.js";

const header = z.object({ name: z.string(), value: z.string() });
type GmailPart = { mimeType?: string; filename?: string; headers?: Array<{ name: string; value: string }>; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GmailPart[] };
const gmailPart: z.ZodType<GmailPart> = z.lazy(() => z.object({ mimeType: z.string().optional(), filename: z.string().optional(), headers: z.array(header).optional(), body: z.object({ data: z.string().optional(), attachmentId: z.string().optional(), size: z.number().optional() }).optional(), parts: z.array(gmailPart).optional() }));
const gmailMessage = z.object({ id: z.string(), threadId: z.string(), snippet: z.string().optional(), payload: gmailPart.optional(), labelIds: z.array(z.string()).optional() });
const gmailPage = z.object({ messages: z.array(z.object({ id: z.string() })).default([]), nextPageToken: z.string().optional(), resultSizeEstimate: z.number().optional() });
const gmailDraft = z.object({ id: z.string(), message: gmailMessage });
const graphAddress = z.object({ emailAddress: z.object({ name: z.string().optional(), address: z.string() }) });
const graphMessage = z.object({ id: z.string(), subject: z.string(), from: graphAddress.optional(), toRecipients: z.array(graphAddress).default([]), ccRecipients: z.array(graphAddress).default([]), bccRecipients: z.array(graphAddress).default([]), receivedDateTime: z.string().optional(), bodyPreview: z.string().optional(), body: z.object({ contentType: z.string(), content: z.string() }).optional(), hasAttachments: z.boolean().optional(), webLink: z.string().optional(), isDraft: z.boolean().optional() });
const graphAttachments = z.object({ value: z.array(z.object({ id: z.string(), name: z.string(), contentType: z.string().optional(), size: z.number(), isInline: z.boolean().optional(), "@odata.type": z.string().optional() })) });
const graphFileAttachment = z.object({ id: z.string(), name: z.string(), contentType: z.string().optional(), contentBytes: z.string(), "@odata.type": z.literal("#microsoft.graph.fileAttachment") });
const googleBase = "https://gmail.googleapis.com/gmail/v1/users/me/";
const graphBase = "https://graph.microsoft.com/v1.0/me/";
const graphFields = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,webLink,isDraft";
const googleHeader = (part: GmailPart | undefined, name: string) => part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
function parts(part: GmailPart | undefined): GmailPart[] { return part ? [part, ...(part.parts ?? []).flatMap(parts)] : []; }
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");
function gmailSummary(value: z.infer<typeof gmailMessage>) {
  return { id: value.id, threadId: value.threadId, subject: googleHeader(value.payload, "Subject"), from: googleHeader(value.payload, "From"), to: googleHeader(value.payload, "To"), date: googleHeader(value.payload, "Date"), snippet: value.snippet ?? "", url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(value.threadId)}` };
}
function outgoingMime(message: MailOutgoing, sender: string, extraHeaders: Array<{ name: string; value: string }> = []) {
  const subjectParts: string[] = [];
  let current = "";
  for (const char of message.subject) { if (Buffer.byteLength(current + char) > 42) { subjectParts.push(current); current = ""; } current += char; }
  subjectParts.push(current);
  const subject = subjectParts.filter(Boolean).map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
  const body = Buffer.from(message.body).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return ["MIME-Version: 1.0", `From: ${sender}`, `To: ${message.to.join(",\r\n ")}`, ...(message.cc.length ? [`Cc: ${message.cc.join(",\r\n ")}`] : []), ...(message.bcc.length ? [`Bcc: ${message.bcc.join(",\r\n ")}`] : []), `Subject: ${subject}`,
    ...extraHeaders.map(({ name, value }) => `${name}: ${value}`), "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
}
function graphOutgoing(message: MailOutgoing) {
  const addresses = (values: string[]) => values.map((address) => ({ emailAddress: { address } }));
  return { subject: message.subject, body: { contentType: "Text", content: message.body }, toRecipients: addresses(message.to), ccRecipients: addresses(message.cc), bccRecipients: addresses(message.bcc) };
}
function replyAddresses(value: string): string[] {
  const values: string[] = [];
  let current = "", quoted = false, angled = false, escaped = false;
  for (const char of value) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quoted) { current += char; escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") angled = true;
    if (!quoted && char === ">") angled = false;
    if (!quoted && !angled && char === ",") { values.push(current); current = ""; } else current += char;
  }
  if (quoted || angled || escaped) throw new ApiError(422, "mail_reply_invalid", "The original recipients are ambiguous. Create a draft with explicit recipients.");
  if (current.trim()) values.push(current);
  return values.map((item) => {
    const address = item.match(/<([^<>]+)>/)?.[1] ?? item.trim();
    if (!z.email().safeParse(address).success) throw new ApiError(422, "mail_reply_invalid", "The original recipients cannot be read safely. Create a draft with explicit recipients.");
    return address;
  });
}

/** Fixed provider endpoints. Provider cursors never become arbitrary authenticated URLs. */
export async function mailProviderAction(account: SavedMailAccount, action: MailAction, signal?: AbortSignal): Promise<unknown> {
  const headers = { Authorization: `Bearer ${account.accessToken}` };
  const get = <T>(url: string | URL, schema: z.ZodType<T>, maxBytes?: number) => mailJson(url, schema, { headers, signal }, maxBytes);
  const post = <T>(url: string | URL, schema: z.ZodType<T>, value: unknown) => mailJson(url, schema, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(value), signal });
  const googlePath = (id: string) => `${googleBase}messages/${encodeURIComponent(id)}`;
  const graphPath = (id: string) => `${graphBase}messages/${encodeURIComponent(id)}`;
  if (account.provider === "gmail") {
    if (action.action === "search") {
      const url = new URL(`${googleBase}messages`);
      url.search = new URLSearchParams({ q: action.query, maxResults: String(action.limit), ...(action.cursor ? { pageToken: action.cursor } : {}) }).toString();
      const page = await get(url, gmailPage);
      const messages = await Promise.all(page.messages.map(({ id }) => get(`${googlePath(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`, gmailMessage).then(gmailSummary)));
      return { messages, nextCursor: page.nextPageToken ?? null, source: "gmail", untrustedContent: true };
    }
    if (action.action === "read") {
      const message = await get(`${googlePath(action.messageId)}?format=full`, gmailMessage);
      const all = parts(message.payload);
      const text = all.find((part) => part.mimeType === "text/plain" && part.body?.data);
      const html = all.find((part) => part.mimeType === "text/html" && part.body?.data);
      return { ...gmailSummary(message), body: text?.body?.data ? decode(text.body.data) : html?.body?.data ? decode(html.body.data) : "", contentType: text ? "text/plain" : "text/html",
        attachments: all.flatMap((part) => part.body?.attachmentId ? [{ id: part.body.attachmentId, filename: part.filename ?? "", contentType: part.mimeType, size: part.body.size }] : []), source: "gmail", untrustedContent: true };
    }
    if (action.action === "attachment") {
      const value = await get(`${googlePath(action.messageId)}/attachments/${encodeURIComponent(action.attachmentId)}`, z.object({ data: z.string(), size: z.number() }), 35 * 1024 * 1024);
      const bytes = Buffer.from(value.data, "base64url");
      if (bytes.length !== value.size || bytes.length > 25 * 1024 * 1024) throw new ApiError(502, "mail_attachment_invalid", "The email attachment was incomplete or too large.");
      const message = await get(`${googlePath(action.messageId)}?format=full`, gmailMessage);
      const metadata = parts(message.payload).find((part) => part.body?.attachmentId === action.attachmentId);
      if (!metadata) throw new ApiError(404, "mail_attachment_missing", "This attachment is no longer present in the email.");
      return { filename: metadata.filename, contentType: metadata.mimeType, contentBase64: bytes.toString("base64"), size: value.size, source: "gmail", untrustedContent: true };
    }
    if (action.action === "draft") return post(`${googleBase}drafts`, gmailDraft, { message: { raw: Buffer.from(outgoingMime(action, account.email)).toString("base64url") } });
    if (action.action === "reply_draft") {
      const original = await get(`${googlePath(action.messageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Reply-To&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`, gmailMessage);
      const target = googleHeader(original.payload, "Reply-To") || googleHeader(original.payload, "From");
      // Use the provider's exact original address headers without accepting header injection.
      const addresses = replyAddresses(target);
      const messageId = googleHeader(original.payload, "Message-ID");
      const references = googleHeader(original.payload, "References");
      if (!addresses.length || !messageId || /[\r\n\x00]/.test(messageId + references)) throw new ApiError(422, "mail_reply_invalid", "This email does not contain usable reply headers.");
      const others = action.replyAll ? [...replyAddresses(googleHeader(original.payload, "To")), ...replyAddresses(googleHeader(original.payload, "Cc"))] : [];
      const recipients = [...new Set([...addresses, ...others].map((item) => item.toLowerCase()))].filter((item) => item !== account.email.toLowerCase());
      if (!recipients.length) throw new ApiError(422, "mail_reply_invalid", "This reply has no recipients. Create a new draft with explicit recipients.");
      const subject = googleHeader(original.payload, "Subject");
      if (/[\r\n\x00]/.test(subject)) throw new ApiError(422, "mail_reply_invalid", "This email has an invalid subject.");
      const raw = outgoingMime({ to: [recipients[0]!], cc: recipients.slice(1), bcc: [], subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, body: action.body }, account.email, [{ name: "In-Reply-To", value: messageId }, { name: "References", value: `${references} ${messageId}`.trim() }]);
      return post(`${googleBase}drafts`, gmailDraft, { message: { threadId: original.threadId, raw: Buffer.from(raw).toString("base64url") } });
    }
    return post(`${googleBase}messages/send`, z.object({ id: z.string(), threadId: z.string() }), { raw: Buffer.from(outgoingMime(action, account.email)).toString("base64url") });
  }
  if (action.action === "search") {
    const url = action.cursor ? new URL(action.cursor) : new URL(`${graphBase}messages`);
    if (url.origin !== "https://graph.microsoft.com" || url.pathname !== "/v1.0/me/messages" || url.username || url.password || url.hash) throw new ApiError(400, "mail_cursor_invalid", "Use the continuation cursor returned by this Outlook search.");
    if (!action.cursor) url.search = new URLSearchParams({ "$search": JSON.stringify(action.query), "$top": String(action.limit), "$select": graphFields }).toString();
    const page = await get(url, z.object({ value: z.array(graphMessage), "@odata.nextLink": z.string().optional() }));
    return { messages: page.value, nextCursor: page["@odata.nextLink"] ?? null, source: "outlook", untrustedContent: true };
  }
  if (action.action === "read") {
    const message = await get(`${graphPath(action.messageId)}?$select=${graphFields},body,bccRecipients`, graphMessage);
    const attachments = message.hasAttachments ? await get(`${graphPath(action.messageId)}/attachments?$select=id,name,contentType,size,isInline`, graphAttachments) : { value: [] };
    return { ...message, attachments: attachments.value, source: "outlook", untrustedContent: true };
  }
  if (action.action === "attachment") {
    const value = await get(`${graphPath(action.messageId)}/attachments/${encodeURIComponent(action.attachmentId)}`, graphFileAttachment, 35 * 1024 * 1024);
    if (Buffer.from(value.contentBytes, "base64").byteLength > 25 * 1024 * 1024) throw new ApiError(413, "mail_attachment_too_large", "This attachment exceeds the 25 MB plugin limit.");
    return { filename: value.name, contentType: value.contentType, contentBase64: value.contentBytes, size: Buffer.from(value.contentBytes, "base64").byteLength, source: "outlook", untrustedContent: true };
  }
  if (action.action === "draft") return post(`${graphBase}messages`, graphMessage, graphOutgoing(action));
  if (action.action === "reply_draft") return post(`${graphPath(action.messageId)}/${action.replyAll ? "createReplyAll" : "createReply"}`, graphMessage, { message: { body: { contentType: "Text", content: action.body } } });
  await post(`${graphBase}sendMail`, z.null(), { message: graphOutgoing(action), saveToSentItems: true });
  return { accepted: true };
}
