import { acceptPrivateProposal, captureProfile, submissionOriginals } from "../time-capture/routes.js";
import { z } from "zod";
import { requiresTimeAllocations, TimesheetCommandSchema, TimesheetStateSchema } from "./timesheet-schema.js";
import type { ServerConfig } from "../types.js";
import type { RequestContext } from "../routes/registry.js";
import { ApiError } from "../errors.js";
import { readProjectDetails } from "../project-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { intakeRequest, requireIntakeClient } from "../eigenwelt-intake.js";
import { requireBackOfficePrincipal } from "./accounts.js";
import { backOfficeDirectoryIdentity, type backOfficeAccess } from "./access.js";
import type { BackOfficeStore } from "./store.js";
import { readTimeDocument, readTimesheet, timeError } from "./timesheet-data.js";
import { commandTimesheet } from "./timesheet.js";
import { DEFAULT_INTERNAL_PERSON_TYPES } from "./schema.js";
import { submitFirmComparisons } from "./timesheet-sharing.js";

type Access = Awaited<ReturnType<typeof backOfficeAccess>>;
type Handler = (ctx: RequestContext, store: BackOfficeStore, access: Access) => Promise<unknown>;

export function registerTimesheetRoutes(
  config: ServerConfig,
  route: (method: string, path: string, action: Handler) => void,
  input: (ctx: RequestContext) => Promise<unknown>,
) {
  async function assertIdentity(ctx: RequestContext, store: BackOfficeStore, access: Access) {
    const { scope, actor } = access;
    const query = ctx.url.searchParams;
    if (
      (query.has("profileId") &&
        query.get("profileId") !== (await captureProfile(config, access)).profileId) ||
      (query.has("expectedUserId") && query.get("expectedUserId") !== actor.userId) ||
      (query.has("expectedPrincipalKey") && query.get("expectedPrincipalKey") !== actor.principalKey) ||
      (query.has("directoryId") &&
        query.get("directoryId") !== (await backOfficeDirectoryIdentity(config, scope, store)))
    )
      timeError("The connected directory changed. Reopen this timesheet.", 409);
    store.requireAccount(scope, actor);
  }
  async function platform(access: Access, method: string, path: string, body?: unknown) {
    const principal = access.actor.principalKey;
    if (!principal) timeError("Sign in to the firm to use shared timesheets.", 403);
    await ensureFreshPlatformToken(config);
    const client = requireIntakeClient(await requireBackOfficePrincipal(config, principal));
    try {
      const value = await intakeRequest(client, method, "/api/back-office/timesheet" + path, body);
      await requireBackOfficePrincipal(config, principal);
      return value;
    } catch (error) {
      if (error instanceof ApiError && [404, 501].includes(error.status))
        throw new ApiError(501, "timesheet_service_unavailable", "The connected firm supports Back Office records, but not the timesheet approval service.");
      throw error;
    }
  }
  async function platformState(access: Access, method: string, body?: unknown) {
    const result = TimesheetStateSchema.safeParse(await platform(access, method, "", body));
    if (!result.success || result.data.userId !== access.actor.userId || result.data.scope !== access.scope)
      timeError("The connected firm server did not return this account’s timesheet.", 502);
    return result.data;
  }
  for (const method of ["GET", "POST"]) {
    route(method, "/timesheet", async (ctx, store, access) => {
      const command = method === "POST" ? TimesheetCommandSchema.parse(await input(ctx)) : undefined;
      await assertIdentity(ctx, store, access);
      if (command && (ctx.agentAccess || access.actor.agentId))
        timeError("A person must save or confirm billing workflow changes.", 403);
      const consent = command?.type === "submit"
        ? command.entries.flatMap((r) => r.shareOriginal ? [r.shareOriginal] : [])
        : [];
      if (consent.length && ctx.actor?.type !== "host")
        timeError("Open the local device that holds the private originals.", 403);
      const readOriginals = () => submissionOriginals(config, ctx.url.searchParams.get("profileId"), {
        user: access.actor.userId, scope: access.scope, principal: access.actor.principalKey ?? "",
      }, consent);
      const execute = async () => {
        let recordsOnly = false;
        if (access.scope !== "local" && !command) {
          try { return await platformState(access, "GET"); }
          catch (error) {
            // Only a missing capability selects the existing directory. Never mask
            // expired credentials, invalid responses, or a service outage as a mode change.
            if (!(error instanceof ApiError) || error.code !== "timesheet_service_unavailable") throw error;
            recordsOnly = true;
          }
        }
        if (access.scope !== "local" && !recordsOnly) {
          if (command && requiresTimeAllocations(command)) {
            const current = await platformState(access, "GET");
            if (!current.supportsTimeAllocations)
              timeError("The connected firm does not support split or per-participant time. Update its timesheet service before saving.", 409);
            await assertIdentity(ctx, store, access);
          }
          if (!consent.length || command?.type !== "submit") return platformState(access, method, command);
          const current = await platformState(access, "GET");
          return submitFirmComparisons(command, current, readOriginals, async (submission) => {
            await assertIdentity(ctx, store, access);
            return platformState(access, method, submission);
          });
        }
        const directoryId = await backOfficeDirectoryIdentity(config, access.scope, store);
        const workspaces = await Promise.all(
          config.workspaces.map(async (w) => {
            const details = await readProjectDetails(w.path);
            const matterIds = details.fields.flatMap((f) =>
              f.type === "backoffice" && f.objectId === "matters" && f.value?.directoryId === directoryId
                ? f.value.recordIds
                : [],
            );
            const agreementIds = details.fields.flatMap((f) =>
              f.type === "backoffice" &&
              f.objectId === "feeAgreements" &&
              f.value?.directoryId === directoryId
                ? f.value.recordIds
                : [],
            );
            return { id: w.id, name: w.displayName || w.name, matterIds, agreementIds };
          }),
        );
        const originals = consent.length ? await readOriginals() : undefined;
        await assertIdentity(ctx, store, access);
        const people = [
          { id: access.actor.userId, name: access.scope === "local" ? "Local user" : access.actor.userId },
          ...store.records(access.scope, access.actor, "people").flatMap(({ id, values }) => {
            const { active, name, personType } = values;
            if (
              id === access.actor.userId || active !== true || typeof name !== "string" || !name ||
              typeof personType !== "string" || !DEFAULT_INTERNAL_PERSON_TYPES.includes(personType)
            ) return [];
            return [{ id, name, directoryOnly: true as const }];
          }),
        ];
        if (recordsOnly) {
          const state = readTimesheet(store, access.scope, access.actor, people, workspaces);
          return { ...state, service: "records", canManage: false, canReview: false,
            supportsBillingComparisons: false, supportsTimeAllocations: false,
            entries: state.entries.filter(entry => entry.legacy),
            delegatedEntries: [], adjustments: [], products: [], invoices: [], template: undefined };
        }
        return command
          ? commandTimesheet(store, access.scope, access.actor, people, command, workspaces, originals)
          : readTimesheet(store, access.scope, access.actor, people, workspaces);
      };
      if (command?.type !== "create" || command.source !== "suggestion") return execute();
      if (!command.proposalDigest) timeError("A suggestion must reference its private original.");
      return acceptPrivateProposal(
        config,
        {
          user: access.actor.userId,
          scope: access.scope,
          principal: access.actor.principalKey ?? "",
          profileId: ctx.url.searchParams.get("profileId"),
        },
        command.requestId,
        command.proposalDigest,
        execute,
      );
    });
  }
  for (const kind of ["invoices", "adjustments"] as const)
    route("GET", "/timesheet/" + kind + "/:id/document", async (ctx, store, access) => {
      await assertIdentity(ctx, store, access);
      if (!access.actor.finance) timeError("Billing access is required.", 403);
      const id = z.uuid().parse(ctx.params.id),
        isInvoice = kind === "invoices";
      let document: string, number: string;
      if (access.scope !== "local") {
        const result = z
          .object({
            number: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+-C[0-9]+$/)]),
            document: z.string(),
          })
          .parse(await platform(access, "GET", "/" + kind + "/" + id + "/document"));
        document = result.document;
        number = String(result.number);
      } else {
        const d = readTimeDocument(store, access.scope, id);
        const canReadRecord = (id: string) => {
          const m = store.raw(access.scope, id);
          return m && !m.archivedAt && store.canRead(access.scope, m, access.actor);
        };
        if (
          isInvoice &&
          d?.kind === "invoice" &&
          canReadRecord(d.value.clientId) &&
          d.value.entries.every((e) => canReadRecord(e.matterId))
        ) {
          document = d.document;
          number = String(d.value.number);
        } else if (
          !isInvoice &&
          d?.kind === "adjustment" &&
          d.document &&
          d.value.noteNumber &&
          canReadRecord(d.value.matterId) &&
          d.value.invoiceId
        ) {
          const original = readTimeDocument(store, access.scope, d.value.invoiceId);
          if (original?.kind !== "invoice" || !canReadRecord(original.value.clientId))
            timeError("The issued document is unavailable.", 404);
          document = d.document;
          number = d.value.noteNumber;
        } else timeError("The issued document is unavailable.", 404);
      }
      return new Response(document, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-disposition":
            'attachment; filename="' + (isInvoice ? "Invoice-" : "Correction-") + number + '.html"',
          "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    });
}
