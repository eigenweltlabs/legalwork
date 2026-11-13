import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { EmailDraft, EmailDraftInput } from "@legalwork/types/email-draft";
import { ApiError } from "../errors.js";
import { canonicalFilePath, withFileWriteLocks } from "../file-write-lock.js";
import { renderEml, type EmailAttachment } from "./eml.js";
import { EmailDraftSchema } from "./schema.js";
import { z } from "zod";
import { workspaceFileRoot } from "../project-storage-paths.js";
import PostalMime, { type Address } from "postal-mime";
import { connectorMailDraftTargetSchema, connectorCalendarDraftTargetSchema, connectorDraftDeliverySchema } from "../connectors/schema.js";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function draftPaths(root: string, id: string, kind: "email" | "calendar" = "email") {
  if (!validId.test(id)) throw new ApiError(400, "email_draft_id", "Invalid email draft.");
  const path = `.legalwork/${kind}-drafts/${id}.${kind === "email" ? "eml" : "ics"}`;
  const artifact = await containedPath(root, path);
  const metadata = await containedPath(root, path.replace(/\.(eml|ics)$/, ".json"));
  return { path, artifact, metadata };
}

async function containedPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes("\\") || path.includes("\u0000") || path.split("/").some(part => part === "..")) {
    throw new ApiError(400, "email_draft_path", "Choose a file inside this project.");
  }
  const canonicalRoot = await canonicalFilePath(resolve(root));
  const target = await canonicalFilePath(resolve(canonicalRoot, path));
  const child = relative(canonicalRoot, target);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    throw new ApiError(400, "email_draft_path", "Choose a file inside this project.");
  }
  return target;
}

async function attachmentData(root: string, input: EmailDraftInput, contentPath = root): Promise<EmailAttachment[]> {
  let total = 0;
  const attachments: EmailAttachment[] = [];
  for (const item of input.attachments) {
    const target = await containedPath(workspaceFileRoot({ path: root, contentPath }, item.path), item.path);
    // Open the validated target without following a replaced leaf symlink.
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ApiError(400, "email_attachment", "Attachments must be files.");
      total += info.size;
      if (total > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "email_attachment_size", "Attachments must total 20 MB or less.");
      const data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw new ApiError(409, "email_attachment_changed", "An attachment changed. Save the draft again.");
        offset += bytesRead;
      }
      if ((await file.stat()).size !== info.size) throw new ApiError(409, "email_attachment_changed", "An attachment changed. Save the draft again.");
      attachments.push({ name: item.name || basename(target), contentType: item.contentType, data });
    } finally { await file.close(); }
  }
  return attachments;
}

export async function readDraft(root: string, id: string, kind: "email" | "calendar" = "email"): Promise<unknown> {
  const paths = await draftPaths(root, id, kind);
  try { return JSON.parse(await readFile(paths.metadata, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new ApiError(404, "email_draft_missing", "Email draft not found.");
    throw error;
  }
}

export async function saveEmailDraft(root: string, workspaceId: string, input: EmailDraftInput, previous?: { id: string; revision: string }, connectorTarget?: z.infer<typeof connectorMailDraftTargetSchema>, contentPath = root): Promise<EmailDraft> {
  return EmailDraftSchema.parse(await saveDraftFiles(root, workspaceId, "email", async (_id, current) => {
    const content = renderEml(input, await attachmentData(root, input, contentPath));
    return { input: { ...input, ...editableDraftMetadata(current), ...(connectorTarget ? { connectorTarget } : {}), artifactHash: createHash("sha256").update(content).digest("hex") }, content };
  }, previous));
}

export async function readEmailDraftMime(root: string, draft: EmailDraft, maxBytes: number) {
  const paths = await draftPaths(root, draft.id);
  const file = await open(paths.artifact, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new ApiError(413, "connector_email_size", "This email exceeds the connected provider's upload limit. Reduce its attachments or export the draft.");
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size || (await file.stat()).size !== info.size || createHash("sha256").update(data).digest("hex") !== draft.artifactHash) throw new ApiError(409, "connector_draft_changed", "The draft export changed. Save and review the draft again before continuing.");
    return data;
  } finally { await file.close(); }
}

export function editableDraftMetadata(current: unknown) {
  const saved = z.object({ connectorTarget: z.union([connectorMailDraftTargetSchema, connectorCalendarDraftTargetSchema]).optional(), delivery: connectorDraftDeliverySchema.optional() }).parse(current ?? {});
  if (saved.delivery) throw new ApiError(409, "connector_draft_closed", "This item was handed to the connected app. Open it there to edit, or prepare a new draft.");
  return saved;
}

/** Called inside the draft write lock; retain the provider MIME exactly, including inline parts. */
export async function prepareEmailDraftReload(root: string, draft: EmailDraft, content: Buffer) {
  if (content.length > 25 * 1024 * 1024) throw new ApiError(413, "connector_email_size", "This mailbox draft is too large to reload.");
  const message = await PostalMime.parse(content, { attachmentEncoding: "base64", maxNestingDepth: 32, maxHeadersSize: 256 * 1024, forceRfc822Attachments: true, maxRfc822NestingDepth: 0 })
    .catch(() => { throw new ApiError(502, "connector_api_invalid", "The mailbox draft could not be read. Open it in the mail app to review it."); });
  const addresses = (items: Address[]) => items.flatMap(item => item.group ?? [item]).map(item => item.name ? `${JSON.stringify(item.name)} <${item.address}>` : item.address).join(", ");
  const folder = `.legalwork/email-drafts/attachments/${randomUUID()}`;
  let total = 0;
  const attachments = message.attachments.map((item, index) => {
    if (typeof item.content !== "string" || item.encoding !== "base64") throw new ApiError(502, "connector_api_invalid", "The mailbox draft contained an unreadable attachment.");
    const data = Buffer.from(item.content, "base64");
    total += data.length;
    if (total > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "email_attachment_size", "Attachments must total 20 MB or less.");
    return { data, path: `${folder}/${index}`, name: (item.filename ?? "attachment").replace(/[\\/\r\n\u0000]/g, "_").slice(0, 255), contentType: item.mimeType };
  });
  const parsed = EmailDraftSchema.safeParse({ ...draft, from: addresses(message.from ? [message.from] : []), replyTo: addresses(message.replyTo ?? []),
    to: addresses(message.to ?? []), cc: addresses(message.cc ?? []), bcc: addresses(message.bcc ?? []), subject: message.subject ?? "",
    body: message.text ?? message.html ?? "", html: message.html ?? "", attachments: attachments.map(({ data: _data, ...item }) => item),
    artifactHash: createHash("sha256").update(content).digest("hex") });
  if (!parsed.success) throw new ApiError(502, "connector_api_invalid", "This mailbox draft cannot be displayed safely. Review it in the mail app.");
  if (attachments.length) {
    await mkdir(await containedPath(root, folder), { recursive: true, mode: 0o700 });
    for (const item of attachments) {
      const file = await open(await containedPath(root, item.path), "wx", 0o600);
      try { await file.writeFile(item.data); } finally { await file.close(); }
    }
  }
  return { input: parsed.data, content };
}

export async function saveDraftFiles<T extends object>(root: string, workspaceId: string, kind: "email" | "calendar", prepare: (id: string, previous: unknown) => Promise<{ input: T; content: string | Buffer }>, previous?: { id: string; revision: string }) {
  const id = previous?.id ?? randomUUID();
  const paths = await draftPaths(root, id, kind);
  return withFileWriteLocks([paths.metadata, paths.artifact], async () => {
    const current = previous ? await readDraft(root, id, kind) : null;
    if (previous) {
      if (!current || typeof current !== "object" || !("revision" in current) || current.revision !== previous.revision || !("workspaceId" in current) || current.workspaceId !== workspaceId) {
        throw new ApiError(409, "draft_conflict", "This draft changed. Reload it before saving; your edits are still here.");
      }
    }
    const { input, content } = await prepare(id, current);
    const draft = { ...input, id, workspaceId, revision: randomUUID(), path: paths.path, updatedAt: Date.now() };
    await mkdir(dirname(paths.metadata), { recursive: true });
    await draftPaths(root, id, kind);
    const suffix = `.tmp-${randomUUID()}`;
    const artifactTemp = paths.artifact + suffix, jsonTemp = paths.metadata + suffix;
    try {
      const artifact = await open(artifactTemp, "wx", 0o600);
      try { await artifact.writeFile(content, "utf8"); } finally { await artifact.close(); }
      const jsonFile = await open(jsonTemp, "wx", 0o600);
      try { await jsonFile.writeFile(JSON.stringify(draft), "utf8"); } finally { await jsonFile.close(); }
      await rename(artifactTemp, paths.artifact);
      await rename(jsonTemp, paths.metadata);
    } finally { await Promise.all([rm(artifactTemp, { force: true }), rm(jsonTemp, { force: true })]); }
    return draft;
  });
}
