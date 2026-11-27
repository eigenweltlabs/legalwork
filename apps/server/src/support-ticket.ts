import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { z } from "zod";
import type { StartupSupportView } from "@legalwork/types/desktop-ipc";
import { resolveServerConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { EIGENWELT_DEPLOYMENTS, eigenweltConnectionPlatformUrl } from "./eigenwelt-endpoints.js";
import { EIGENWELT_BOOTSTRAP_PLATFORM_URL } from "./native-shared-values.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { createDiagnosticRedactor } from "./support-diagnostics.js";
import type { ServerConfig } from "./types.js";

export const supportTicketInput = z.strictObject({
  description: z.string().trim().min(1).max(3000),
  logDays: z.int().min(1).max(365).optional(),
});
const receiptSchema = z.object({ ticketId: z.string().min(1), attachedLogs: z.boolean() });
const compressLogs = promisify(gzip);
const MAX_REQUEST_BYTES = 9 * 1024 * 1024;
const SUPPORT_ORIGINS = new Set([
  EIGENWELT_BOOTSTRAP_PLATFORM_URL,
  ...Object.values(EIGENWELT_DEPLOYMENTS).map(deployment => deployment.platform),
]);

function authenticatedSupportAccount(connection: Awaited<ReturnType<typeof readEigenweltConnection>>) {
  const { account, platformToken, refreshToken, platformTokenExpiresAt } = connection;
  if (!account?.userId || !account.userEmail ||
    (!refreshToken && (!platformToken || (platformTokenExpiresAt ?? 0) <= Date.now()))) return null;
  try {
    const platformURL = eigenweltConnectionPlatformUrl(connection);
    return SUPPORT_ORIGINS.has(platformURL) ? { ...account, userEmail: account.userEmail, platformURL } : null;
  } catch {
    return null;
  }
}

export async function supportTicketAvailable(config: ServerConfig): Promise<boolean> {
  return Boolean(config.desktopSupport && !config.readOnly && authenticatedSupportAccount(await readEigenweltConnection(config)));
}

const supportContactSchema = z.object({ contact: z.object({
  name: z.string().trim().min(1).max(150),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
  email: z.email(),
  calendarUrl: z.url({ protocol: /^https$/ }),
  endsAt: z.iso.datetime(),
}).nullable() });

export async function readSupportContact(config: ServerConfig, signal: AbortSignal) {
  const before = await readEigenweltConnection(config);
  if (!before.account || !(before.platformToken || before.refreshToken)) {
    throw new ApiError(401, "support_sign_in_required", "Sign in with Eigenwelt to view support contacts.");
  }
  const token = await ensureFreshPlatformToken(config);
  const connection = await readEigenweltConnection(config);
  if (!token || token !== connection.platformToken || !connection.account ||
    before.account.userId !== connection.account.userId || before.account.orgId !== connection.account.orgId) {
    throw new ApiError(401, "support_sign_in_required", "Sign in with Eigenwelt to view support contacts.");
  }
  return fetchSupportContact(config, connection, token, signal);
}

async function fetchSupportContact(config: Pick<ServerConfig, "configPath">, connection: Awaited<ReturnType<typeof readEigenweltConnection>>,
    token: string, signal: AbortSignal) {
  try {
    const platformURL = eigenweltConnectionPlatformUrl(connection);
    if (!SUPPORT_ORIGINS.has(platformURL)) throw new Error("Unexpected platform.");
    const response = await fetch(new URL("/api/desktop/support/contact", platformURL), {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status === 401 || response.status === 403)
      throw new ApiError(401, "support_sign_in_required", "Sign in with Eigenwelt to view support contacts.");
    if (!response.ok) throw new Error("Contact lookup failed.");
    const result = supportContactSchema.parse(await response.json());
    const latest = await readEigenweltConnection(config);
    if (!latest.account || latest.account.userId !== connection.account?.userId || latest.account.orgId !== connection.account.orgId)
      throw new ApiError(401, "support_sign_in_required", "The signed-in account changed.");
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "support_contact_unavailable", "Team contact details are temporarily unavailable.");
  }
}

/** Host-only recovery lookup. It works without a listening server or an engine. */
export async function readStartupSupport(configPath: string, includeContact: boolean): Promise<StartupSupportView> {
  const location = { configPath };
  const signedOut = { authenticated: false, contact: null };
  const before = await readEigenweltConnection(location);
  const identity = authenticatedSupportAccount(before);
  if (!identity) return signedOut;
  if (!includeContact) return { authenticated: true, contact: null };

  try {
    const signal = AbortSignal.timeout(5000);
    const result = before.platformToken && (before.platformTokenExpiresAt ?? 0) > Date.now()
      ? await fetchSupportContact(location, before, before.platformToken, signal)
      : await readSupportContact(await resolveServerConfig({ configPath, workspaces: [] }), signal);
    return { authenticated: true, contact: result.contact };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return signedOut;
    const latest = authenticatedSupportAccount(await readEigenweltConnection(location));
    return latest && latest.userId === identity.userId && latest.orgId === identity.orgId
      ? { authenticated: true, contact: null, unavailable: true }
      : signedOut;
  }
}

export async function submitSupportTicket(config: ServerConfig, input: z.infer<typeof supportTicketInput>, signal: AbortSignal) {
  const support = config.desktopSupport;
  if (!support || config.readOnly) throw new ApiError(403, "support_unavailable", "Open a local LegalWork desktop chat to send feedback.");
  const account = authenticatedSupportAccount(await readEigenweltConnection(config));
  if (!account) throw new ApiError(401, "support_sign_in_required", "Sign in with Eigenwelt to send a support ticket.");
  const cleaned = createDiagnosticRedactor().clean({ description: input.description });
  const { description } = supportTicketInput.parse(cleaned);
  const choice = await support.confirm(signal);
  if (choice === "cancel" || signal.aborted) return { submitted: false, reason: "cancelled" };

  const token = await ensureFreshPlatformToken(config);
  const currentConnection = await readEigenweltConnection(config);
  const current = authenticatedSupportAccount(currentConnection);
  if (!token || token !== currentConnection.platformToken || !current || current.userId !== account.userId ||
      current.orgId !== account.orgId || current.userEmail !== account.userEmail || current.platformURL !== account.platformURL)
    throw new ApiError(401, "support_account_changed", "Your sign-in changed or expired. Reopen the support dialog to submit the report.");

  let detailedLogs: string | undefined;
  if (choice === "with_logs") {
    try {
      const exported = await support.collectLogs(input.logDays ?? 2, signal);
      if (!exported) throw new Error("Detailed support export was empty.");
      detailedLogs = (await compressLogs(exported)).toString("base64");
    } catch {
      throw new ApiError(503, "support_log_collection_failed", "LegalWork could not collect the detailed support logs. Try again or choose Send without logs.");
    }
  }
  const body = JSON.stringify({ description, ...(detailedLogs ? { detailedLogs } : {}) });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw new ApiError(413, "support_logs_too_large", "This detailed log export is too large to attach. Ask LegalWork to use a shorter period, or export the full file from Settings > Updates.");
  const latest = await readEigenweltConnection(config);
  if (latest.platformToken !== token || latest.account?.userId !== account.userId ||
      latest.account.orgId !== account.orgId || latest.account.userEmail !== account.userEmail ||
      authenticatedSupportAccount(latest)?.platformURL !== account.platformURL)
    throw new ApiError(401, "support_account_changed", "Your sign-in changed or expired. Reopen the support dialog to submit the report.");
  signal.throwIfAborted();

  let response: Response;
  try {
    response = await fetch(new URL("/api/desktop/support", account.platformURL), {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
    });
  } catch {
    throw new ApiError(502, "support_delivery_unknown", "LegalWork could not confirm delivery of the support ticket. Avoid sending it again until delivery has been checked.");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok && result && typeof result === "object" && "code" in result) {
    if (result.code === "support_sign_in_required")
      throw new ApiError(401, "support_sign_in_required", "Sign in again with Eigenwelt to send a support ticket.");
    if (result.code === "support_email_required")
      throw new ApiError(422, "support_email_required", "Support needs a primary email address on your Eigenwelt account.");
    if (result.code === "support_rate_limited")
      throw new ApiError(429, "support_rate_limited", "Too many support requests. Try again in a few minutes.");
    if (result.code === "support_attachment_failed")
      throw new ApiError(503, "support_attachment_failed", "Support could not accept the log attachment. You can try again or choose Send without logs.");
    if (result.code === "support_unavailable")
      throw new ApiError(503, "support_unavailable", "The Eigenwelt Labs support inbox is temporarily unavailable.");
  }
  const receipt = receiptSchema.safeParse(result);
  if (!response.ok || !receipt.success || receipt.data.attachedLogs !== Boolean(detailedLogs))
    throw new ApiError(502, "support_delivery_unknown", "LegalWork could not confirm delivery of the support ticket. Avoid sending it again until delivery has been checked.");
  return { submitted: true, ...receipt.data };
}
