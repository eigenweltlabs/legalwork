import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { savedConnectorConnections } from "./broker.js";
import { accountInput, nativeId, nativePagePath, parseNative } from "./native.js";
import { createConnectorRequest, type ConnectorRequest } from "./request.js";

const leafName = z.string().trim().min(1).max(225).refine((value) => !/[\x00-\x1f/\\]/.test(value) && value !== "." && value !== "..", "Choose a single label or folder name.");
export const mailContainersInput = accountInput.extend({ parentId: nativeId.optional(), pageToken: z.string().max(8192).optional() }).strict();
export const mailContainerCreateInput = accountInput.extend({ name: leafName, parentId: nativeId.optional() }).strict();
export const mailCategoryCreateInput = accountInput.extend({ name: z.string().trim().min(1).max(255).regex(/^[^\x00-\x1f]+$/), color: z.string().regex(/^(none|preset([0-9]|1[0-9]|2[0-4]))$/).default("none") }).strict();
export const mailCategoryListInput = accountInput.extend({ pageToken: z.string().max(8192).optional() }).strict();
const identifiers = z.array(nativeId).max(100).default([]);
export const mailOrganizeInput = accountInput.extend({
  messageIds: z.array(nativeId).min(1).max(50).refine((values) => new Set(values).size === values.length, "Choose each message once."),
  addLabelIds: identifiers, removeLabelIds: identifiers,
  addCategories: z.array(z.string().min(1).max(255)).max(25).default([]), removeCategories: z.array(z.string().min(1).max(255)).max(25).default([]),
  destinationFolderId: nativeId.optional(), archive: z.boolean().optional(), isRead: z.boolean().optional(), starred: z.boolean().optional(), flagged: z.boolean().optional(),
}).strict().refine((input) => input.archive === undefined || input.destinationFolderId === undefined, "Choose archive or a destination folder.")
  .refine((input) => input.addLabelIds.length + input.removeLabelIds.length + input.addCategories.length + input.removeCategories.length > 0 || [input.destinationFolderId, input.archive, input.isRead, input.starred, input.flagged].some((value) => value !== undefined), "Choose an organization change.")
  .refine((input) => !input.addLabelIds.some((id) => input.removeLabelIds.includes(id)) && !input.addCategories.some((name) => input.removeCategories.includes(name)), "Cannot add and remove the same tag.");
export const mailApplyOrganizationInput = z.object({ planId: z.uuid() }).strict();

const gmailLabel = z.object({ id: z.string(), name: z.string(), type: z.string().optional() });
const folder = z.object({ id: z.string(), displayName: z.string(), parentFolderId: z.string().optional(), childFolderCount: z.number().optional() });
const category = z.object({ id: z.string(), displayName: z.string(), color: z.string() });
const graphHeaders = { Prefer: 'IdType="ImmutableId"' };
const googleRoot = "/gmail/v1/users/me";
const graphRoot = "/v1.0/me";
const messageMetadata = z.object({
  id: z.string(), labelIds: z.array(z.string()).default([]),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }).optional(),
  subject: z.string().nullish(), parentFolderId: z.string().optional(), categories: z.array(z.string()).default([]),
  isRead: z.boolean().optional(), flag: z.object({ flagStatus: z.string() }).optional(),
  changeKey: z.string().optional(), "@odata.etag": z.string().optional(),
});
type Metadata = z.infer<typeof messageMetadata>;
type Change = z.infer<typeof mailOrganizeInput>;
type MailId = "gmail" | "outlook";
type Plan = { connectorId: MailId; connectionId: string; accountIdentity: string; expiresAt: number; input: Change; messages: Metadata[] };
const plans = new WeakMap<ServerConfig, Map<string, Plan>>();
const expiredPlan = () => new ApiError(409, "connector_organization_preview_required", "Preview these email changes again. This preview expired, was already used, or belongs to another account.");

function provider(id: string): MailId {
  if (id !== "gmail" && id !== "outlook") throw new ApiError(400, "invalid_payload", "Choose an email connector.");
  return id;
}

export async function listMailContainers(id: string, request: ConnectorRequest, input: z.infer<typeof mailContainersInput>) {
  if (provider(id) === "gmail") {
    if (input.parentId || input.pageToken) throw new ApiError(400, "invalid_payload", "Gmail returns all labels in one list, including nested label names.");
    return { labels: parseNative(z.object({ labels: z.array(gmailLabel).default([]) }), await request(`${googleRoot}/labels`)).labels, nextPageToken: null };
  }
  const endpoint = input.parentId ? `${graphRoot}/mailFolders/${encodeURIComponent(input.parentId)}/childFolders` : `${graphRoot}/mailFolders`;
  const path = input.pageToken ? nativePagePath(input.pageToken, "https://graph.microsoft.com", endpoint) : `${endpoint}?$top=50&$select=id,displayName,parentFolderId,childFolderCount`;
  const page = parseNative(z.object({ value: z.array(folder), "@odata.nextLink": z.string().optional() }), await request(path));
  if (page["@odata.nextLink"]) nativePagePath(page["@odata.nextLink"], "https://graph.microsoft.com", endpoint);
  return { folders: page.value, nextPageToken: page["@odata.nextLink"] ?? null };
}

export async function createMailContainer(id: string, request: ConnectorRequest, input: z.infer<typeof mailContainerCreateInput>) {
  if (provider(id) === "gmail") {
    let name = input.name;
    if (input.parentId) {
      const parent = parseNative(gmailLabel, await request(`${googleRoot}/labels/${encodeURIComponent(input.parentId)}`));
      if (parent.type !== "user") throw new ApiError(400, "invalid_payload", "Create sublabels under a user label.");
      name = `${parent.name}/${name}`;
    }
    if (name.length > 225) throw new ApiError(400, "invalid_payload", "The full nested label name is too long.");
    return parseNative(gmailLabel, await request(`${googleRoot}/labels`, { method: "POST", organize: true, body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } }));
  }
  const endpoint = input.parentId ? `${graphRoot}/mailFolders/${encodeURIComponent(input.parentId)}/childFolders` : `${graphRoot}/mailFolders`;
  return parseNative(folder, await request(endpoint, { method: "POST", organize: true, body: { displayName: input.name } }));
}

export async function listMailCategories(request: ConnectorRequest, input: z.infer<typeof mailCategoryListInput> = {}) {
  const endpoint = `${graphRoot}/outlook/masterCategories`;
  const path = input.pageToken ? nativePagePath(input.pageToken, "https://graph.microsoft.com", endpoint) : endpoint;
  const page = parseNative(z.object({ value: z.array(category), "@odata.nextLink": z.string().optional() }), await request(path));
  if (page["@odata.nextLink"]) nativePagePath(page["@odata.nextLink"], "https://graph.microsoft.com", endpoint);
  return { categories: page.value, nextPageToken: page["@odata.nextLink"] ?? null };
}
export async function createMailCategory(request: ConnectorRequest, input: z.infer<typeof mailCategoryCreateInput>) {
  return parseNative(category, await request(`${graphRoot}/outlook/masterCategories`, { method: "POST", organize: true, body: { displayName: input.name, color: input.color } }));
}

async function metadata(id: MailId, request: ConnectorRequest, messageId: string) {
  const endpoint = id === "gmail"
    ? `${googleRoot}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`
    : `${graphRoot}/messages/${encodeURIComponent(messageId)}?$select=id,subject,parentFolderId,categories,isRead,flag,changeKey`;
  return parseNative(messageMetadata, await request(endpoint, id === "outlook" ? { headers: graphHeaders } : {}));
}

async function accountIdentity(id: MailId, request: ConnectorRequest) {
  return id === "gmail"
    ? parseNative(z.object({ emailAddress: z.string().min(1) }), await request(`${googleRoot}/profile?fields=emailAddress`)).emailAddress
    // The mailbox root is stable and needs only Mail.Read, unlike the User.Read profile endpoint.
    : parseNative(z.object({ id: z.string().min(1) }), await request(`${graphRoot}/mailFolders/msgfolderroot?$select=id`)).id;
}

function googleChanges(input: Change) {
  const addLabelIds = [...input.addLabelIds];
  const removeLabelIds = [...input.removeLabelIds];
  for (const [value, label] of [[input.archive === undefined ? undefined : !input.archive, "INBOX"], [input.isRead === undefined ? undefined : !input.isRead, "UNREAD"], [input.starred, "STARRED"]]) {
    if (value === true) addLabelIds.push(String(label));
    if (value === false) removeLabelIds.push(String(label));
  }
  return { addLabelIds: [...new Set(addLabelIds)], removeLabelIds: [...new Set(removeLabelIds)] };
}

function summary(message: Metadata) {
  return { id: message.id, subject: message.subject ?? message.payload?.headers.find((header) => header.name.toLowerCase() === "subject")?.value ?? "",
    labelIds: message.labelIds, folderId: message.parentFolderId ?? null, categories: message.categories, isRead: message.isRead ?? !message.labelIds.includes("UNREAD") };
}

export async function previewMailOrganization(config: ServerConfig, connectorId: string, args: Record<string, unknown>) {
  const id = provider(connectorId);
  const parsed = mailOrganizeInput.safeParse(args);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Choose up to 50 unique message IDs and supported organization changes.");
  const input = parsed.data;
  if (id === "gmail" && (input.addCategories.length || input.removeCategories.length || input.destinationFolderId || input.flagged !== undefined)) throw new ApiError(400, "invalid_payload", "Gmail uses label IDs and stars. Use archive to file a labeled message outside the Inbox.");
  if (id === "outlook" && (input.addLabelIds.length || input.removeLabelIds.length || input.starred !== undefined)) throw new ApiError(400, "invalid_payload", "Outlook uses folders, category names and follow-up flags.");
  if (id === "gmail" && Object.values(googleChanges(input)).some((labels) => labels.length > 100)) throw new ApiError(400, "invalid_payload", "A Gmail update can add or remove at most 100 labels, including read status, Inbox and star changes.");
  const request = await createConnectorRequest(config, id, input.connectionId);
  const identity = await accountIdentity(id, request);
  const connections = await savedConnectorConnections(config, id);
  const connection = connections.find((item) => input.connectionId ? item.id === input.connectionId : connections.length === 1);
  if (!connection) throw expiredPlan();
  let destination: unknown = null;
  if (id === "gmail" && (input.addLabelIds.length || input.removeLabelIds.length)) {
    const labels = parseNative(z.object({ labels: z.array(gmailLabel).default([]) }), await request(`${googleRoot}/labels`)).labels;
    for (const labelId of [...input.addLabelIds, ...input.removeLabelIds]) {
      if (!labels.some((label) => label.id === labelId && label.type === "user")) throw new ApiError(400, "invalid_payload", "Choose existing user label IDs from list_labels. Use archive, isRead or starred for system labels.");
    }
    destination = labels.filter((label) => input.addLabelIds.includes(label.id) || input.removeLabelIds.includes(label.id));
  }
  if (id === "outlook") {
    const destinationId = input.archive === undefined ? input.destinationFolderId : input.archive ? "archive" : "inbox";
    if (destinationId) destination = parseNative(folder, await request(`${graphRoot}/mailFolders/${encodeURIComponent(destinationId)}?$select=id,displayName,parentFolderId`));
    if (input.addCategories.length) {
      const missing = new Set(input.addCategories);
      let pageToken: string | undefined;
      const visited = new Set<string>();
      do {
        const page = await listMailCategories(request, { pageToken });
        for (const item of page.categories) missing.delete(item.displayName);
        pageToken = page.nextPageToken ?? undefined;
        if (pageToken && visited.has(pageToken)) throw new ApiError(502, "connector_api_invalid", "Microsoft returned a repeated category page.");
        if (pageToken) visited.add(pageToken);
        if (visited.size > 100) throw new ApiError(413, "connector_category_limit", "This mailbox has too many category pages to preview in one request.");
      } while (missing.size && pageToken);
      if (missing.size) throw new ApiError(400, "invalid_payload", "Choose existing category names, or create the category first.");
    }
    if (destination && typeof destination === "object" && "id" in destination && typeof destination.id === "string") input.destinationFolderId = destination.id;
  }
  const messages: Metadata[] = [];
  for (const messageId of input.messageIds) messages.push(await metadata(id, request, messageId));
  if (id === "gmail" && messages.some((message) => message.labelIds.includes("DRAFT"))) throw new ApiError(400, "connector_draft_organization_unsupported", "Gmail cannot apply labels to drafts. Choose received or sent messages.");
  if (id === "outlook" && (input.addCategories.length || input.removeCategories.length) && messages.some((message) => !message["@odata.etag"] || /[\r\n]/.test(message["@odata.etag"]!))) throw new ApiError(409, "connector_message_version_required", "Microsoft did not return a message version. Categories cannot be safely changed without one.");
  const pending = plans.get(config) ?? new Map<string, Plan>();
  for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
  if (pending.size >= 100) throw new ApiError(429, "connector_preview_limit", "Apply an existing email preview or wait for it to expire before preparing another.");
  const planId = randomUUID();
  const expiresAt = Date.now() + 10 * 60_000;
  pending.set(planId, { connectorId: id, connectionId: connection.id, accountIdentity: identity, input, messages, expiresAt });
  plans.set(config, pending);
  return { planId, expiresAt, count: messages.length, messages: messages.map(summary), changes: input, destination, applied: false,
    instruction: "Show these exact messages and changes to the user before applying. This plan applies once, only to these messages; future replies are not included." };
}

export async function applyMailOrganization(config: ServerConfig, connectorId: string, args: Record<string, unknown>) {
  const id = provider(connectorId);
  const parsed = mailApplyOrganizationInput.safeParse(args);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Choose the planId returned by an email organization preview.");
  const { planId } = parsed.data;
  const plan = plans.get(config)?.get(planId);
  if (!plan || plan.connectorId !== id || plan.expiresAt <= Date.now()) throw expiredPlan();
  // Reserve synchronously, before any await: concurrent callers cannot replay a batch.
  plans.get(config)?.delete(planId);
  const request = await createConnectorRequest(config, id, plan.connectionId);
  if (await accountIdentity(id, request) !== plan.accountIdentity) throw expiredPlan();
  const results: { messageId: string; currentMessageId?: string; status: "applied" | "failed" | "partial" | "uncertain"; code?: string }[] = [];
  for (const before of plan.messages) {
    let writing = false;
    let completedSteps = 0;
    try {
      const current = await metadata(id, request, before.id);
      if (id === "gmail") {
        if (JSON.stringify([...current.labelIds].sort()) !== JSON.stringify([...before.labelIds].sort())) throw new ApiError(409, "connector_message_changed", "This message's labels changed. Preview it again.");
        writing = true;
        await request(`${googleRoot}/messages/${encodeURIComponent(current.id)}/modify`, { method: "POST", organize: true, body: googleChanges(plan.input) });
        writing = false;
        completedSteps++;
      } else {
        if (current.changeKey !== before.changeKey || current["@odata.etag"] !== before["@odata.etag"]) throw new ApiError(409, "connector_message_changed", "This message changed. Preview it again.");
        const body: { categories?: string[]; isRead?: boolean; flag?: { flagStatus: string } } = {};
        if (plan.input.addCategories.length || plan.input.removeCategories.length) body.categories = [...new Set([...current.categories.filter((name) => !plan.input.removeCategories.includes(name)), ...plan.input.addCategories])];
        if (plan.input.isRead !== undefined) body.isRead = plan.input.isRead;
        if (plan.input.flagged !== undefined) body.flag = { flagStatus: plan.input.flagged ? "flagged" : "notFlagged" };
        if (Object.keys(body).length) {
          const etag = current["@odata.etag"];
          writing = true;
          await request(`${graphRoot}/messages/${encodeURIComponent(current.id)}`, { method: "PATCH", organize: true, headers: { ...graphHeaders, ...(etag ? { "If-Match": etag } : {}) }, body });
          writing = false;
          completedSteps++;
        }
        if (plan.input.destinationFolderId && current.parentFolderId !== plan.input.destinationFolderId) {
          writing = true;
          const moved = parseNative(z.object({ id: z.string() }), await request(`${graphRoot}/messages/${encodeURIComponent(current.id)}/move`, { method: "POST", organize: true, headers: graphHeaders, body: { destinationId: plan.input.destinationFolderId } }));
          results.push({ messageId: before.id, currentMessageId: moved.id, status: "applied" });
          continue;
        }
      }
      results.push({ messageId: before.id, currentMessageId: current.id, status: "applied" });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "connector_api_failed";
      const uncertain = writing && (!(error instanceof ApiError) || error.status >= 500);
      results.push({ messageId: before.id, status: uncertain ? "uncertain" : completedSteps ? "partial" : "failed", code });
    }
  }
  return { planId, results, applied: results.filter((item) => item.status === "applied").length,
    failed: results.filter((item) => item.status === "failed").length, partial: results.filter((item) => item.status === "partial").length, uncertain: results.filter((item) => item.status === "uncertain").length };
}
