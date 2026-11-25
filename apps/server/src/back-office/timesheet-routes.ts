import { authenticateWikiAgentRequest } from "../wiki/agent-access.js";
import { activeCaptureProfile, timekeepingEnabled, timekeepingPreset } from "../time-capture/profile.js";
import { isTimekeepingBillingCommand } from "../time-capture/chat-billing-schema.js";
import {
  acceptPrivateProposal,
  bookPrivateManualDraft,
  captureProfile,
  readCaptureGuidelines,
  type BookingAuthority,
} from "../time-capture/routes.js";
import { z } from "zod";
import {
  requiresTimeAllocations,
  privateBookingRevisionSchema,
  draftRules, soleMatterClient, TimesheetCommandSchema,
  type TimesheetState,
} from "./timesheet-schema.js";
import type { ServerConfig } from "../types.js";
import type { RequestContext } from "../routes/registry.js";
import { ApiError } from "../errors.js";
import {
  readPlatformTimesheet,
  requestPlatformTimesheet,
} from "./timesheet-platform.js";
import { backOfficeDirectoryIdentity, backOfficeAccess } from "./access.js";
import type { BackOfficeStore } from "./store.js";
import {
  readTimeDocument,
  readTimesheet,
  timeError,
  timeWorkspaces,
} from "./timesheet-data.js";
import { commandTimesheet, readTimesheetRequest } from "./timesheet.js";
import { currencyScale } from "./timesheet-schema.js";
import { DEFAULT_INTERNAL_PERSON_TYPES } from "./schema.js";

type Access = Awaited<ReturnType<typeof backOfficeAccess>>;
type Handler = (
  ctx: RequestContext,
  store: BackOfficeStore,
  access: Access,
) => Promise<unknown>;

export function registerTimesheetRoutes(
  config: ServerConfig,
  route: (method: string, path: string, action: Handler) => void,
  input: (ctx: RequestContext) => Promise<unknown>,
) {
  async function assertIdentity(
    ctx: RequestContext,
    store: BackOfficeStore,
    access: Access,
  ) {
    const { scope, actor } = access;
    const query = ctx.url.searchParams;
    if (
      (query.has("profileId") &&
        query.get("profileId") !==
          (await captureProfile(config, access)).profileId) ||
      (query.has("expectedUserId") &&
        query.get("expectedUserId") !== actor.userId) ||
      (query.has("expectedPrincipalKey") &&
        query.get("expectedPrincipalKey") !== actor.principalKey) ||
      (query.has("directoryId") &&
        query.get("directoryId") !==
          (await backOfficeDirectoryIdentity(config, scope, store)))
    )
      throw new ApiError(409, "back_office_account_changed", "The connected directory changed. Reopen this timesheet.");
    store.requireAccount(scope, actor);
  }
  const platform = (
    access: Access,
    method: string,
    path: string,
    body?: unknown,
  ) => requestPlatformTimesheet(config, access, method, path, body);
  const platformState = (access: Access, method: string, body?: unknown) =>
    readPlatformTimesheet(config, access, method, body);
  async function assertFinance(
    ctx: RequestContext,
    store: BackOfficeStore,
    access: Access,
  ) {
    const active = await backOfficeAccess(config, access.scope !== "local");
    if (
      !active.actor.finance ||
      active.scope !== access.scope ||
      active.actor.userId !== access.actor.userId ||
      active.actor.principalKey !== access.actor.principalKey
    )
      timeError("Billing access has changed.", 403);
    await assertIdentity(ctx, store, active);
    return active;
  }
  async function localDirectory(store: BackOfficeStore, access: Access) {
    const directoryId = await backOfficeDirectoryIdentity(
      config,
      access.scope,
      store,
    );
    const workspaces = await timeWorkspaces(config.workspaces, directoryId);
    const people = [
      {
        id: access.actor.userId,
        name: access.scope === "local" ? "Local user" : access.actor.userId,
      },
      ...store
        .records(access.scope, access.actor, "people")
        .flatMap(({ id, values }) => {
          const { active, name, personType } = values;
          if (
            id === access.actor.userId ||
            active !== true ||
            typeof name !== "string" ||
            !name ||
            typeof personType !== "string" ||
            !DEFAULT_INTERNAL_PERSON_TYPES.includes(personType)
          )
            return [];
          return [{ id, name, directoryOnly: true as const }];
        }),
    ];
    return { people, workspaces };
  }
  for (const method of ["GET", "POST"]) {
    const timesheet: Handler = async (ctx, store, access) => {
      const inputCommand =
        method === "POST"
          ? TimesheetCommandSchema.parse(await input(ctx))
          : undefined;
      const draftRevision = ctx.url.searchParams.get("draftRevision");
      const expectedDraft = draftRevision === null ? undefined : privateBookingRevisionSchema.parse({
        date: ctx.url.searchParams.get("draftDate"), revision: z.coerce.number().parse(draftRevision),
      });
      await assertIdentity(ctx, store, access);
      let checkedCommand = inputCommand;
      const billingAgent = ctx.agentAccess && await authenticateWikiAgentRequest(config, ctx.request);
      if ((ctx.params.id || ctx.agentAccess) && !billingAgent) timeError("This Timekeeping chat no longer has access.", 403);
      if (billingAgent) {
        const profile = await activeCaptureProfile(config);
        if (ctx.actor?.scope !== "owner" || ctx.params.id !== billingAgent.workspace?.id || billingAgent.workspace?.preset !== timekeepingPreset(profile.profileId) ||
            (await captureProfile(config, access)).path !== profile.path || !await timekeepingEnabled(profile.path))
          timeError("Use the private Timekeeping chat for billing workflow operations.", 403);
        if (expectedDraft || checkedCommand && !isTimekeepingBillingCommand(checkedCommand))
          timeError("This operation requires the corresponding Timekeeping tool or a person in the app.", 403);
        access.actor = { ...access.actor, agentId: "timekeeping" };
        const billingState = async () => {
          if (access.scope !== "local") return platformState(access, "GET");
          const { people, workspaces } = await localDirectory(store, access);
          return readTimesheet(store, access.scope, access.actor, people, workspaces, true, profile.profileId);
        };
        if (checkedCommand?.type === "create") {
          const { entry } = checkedCommand;
          const state = await billingState();
          const matter = state.matters.find(item => item.id === entry.matterId);
          if (!matter) timeError("Choose an accessible matter.", 404);
          const clientId = entry.clientId || soleMatterClient(matter, state.clients);
          const rules = draftRules(state, await readCaptureGuidelines(profile.path), matter, entry.date, entry.projectId, clientId);
          const minimumBillableMinutes = Math.max(entry.minimumBillableMinutes ?? 0, rules.minimumMinutes);
          checkedCommand = { ...checkedCommand, entry: { ...entry, clientId, minimumBillableMinutes: minimumBillableMinutes || undefined } };
        }
        if (checkedCommand?.type === "policy" || checkedCommand?.type === "createInvoice") {
          const state = await billingState();
          let summary: string, description: string;
          if (checkedCommand.type === "policy") {
            if (!state.canManage) timeError("Billing configuration access is required.", 403);
            const policy = checkedCommand.policy;
            const target = [...state.matters, ...state.clients, ...state.projects].find(item => item.id === policy.targetId);
            const reviewer = state.people.find(item => item.id === policy.reviewerId);
            summary = "Save this billing policy?";
            description = [target?.name ?? policy.targetId, "Effective from " + policy.effectiveFrom,
              reviewer ? "Reviewer: " + reviewer.name : "Reviewer: inherited or unassigned",
              JSON.stringify(policy, null, 2)].join("\n");
          } else {
            const { invoice: { clientId, matterId, entries, pricing } } = checkedCommand;
            const client = state.clients.find(row => row.id === clientId);
            const matter = state.matters.find(row => row.id === matterId && row.clientIds.includes(clientId));
            if (!client || !matter) timeError("Choose an accessible matter and billing client.", 404);
            summary = "Create this invoice?";
            description = [matter.name, client.name, entries.length + " time entries",
              pricing.mode === "fixed"
                ? new Intl.NumberFormat("en", { style: "currency", currency: pricing.currency }).format(pricing.amountMinor / currencyScale(pricing.currency))
                : "Hourly fees at the saved rates",
              "This saves a numbered invoice and marks the selected time as invoiced."].join("\n");
          }
          const decision = await ctx.approvals.requestApproval({
            action: "timekeeping.billing." + checkedCommand.type,
            workspaceId: billingAgent.workspace.id, sessionID: billingAgent.sessionId,
            actor: billingAgent.actor, summary, description, paths: [],
          }, ctx.request.signal, true);
          if (!decision.allowed) timeError("The user did not approve this billing change.", 403);
          const current = await authenticateWikiAgentRequest(config, ctx.request);
          if (!current || current.generation !== billingAgent.generation || current.actor.scope !== "owner" ||
              (await activeCaptureProfile(config)).path !== profile.path || !await timekeepingEnabled(profile.path))
            timeError("The timekeeping account changed while awaiting confirmation.", 409);
          await assertFinance(ctx, store, access);
          ctx.request.signal.throwIfAborted();
        }
      } else if (checkedCommand && access.actor.agentId) {
        timeError("Use the private Timekeeping chat for billing workflow operations.", 403);
      }
      const command = checkedCommand;
      if (command?.type === "prepareInvoice" || command?.type === "approveInvoice" ||
          command?.type === "issueInvoice" || command?.type === "reviewInvoiceWording" ||
          command?.type === "template" || command?.type === "invoice")
        timeError("Use Create Invoice to save the invoice record.", 409);
      if (
        command?.type === "submit" &&
        command.entries.some((entry) => entry.shareOriginal)
      )
        timeError(
          "Only the confirmed billing entry can be submitted. Private proposals stay on this device.",
          403,
        );
      let remoteRejectedCreate = false;
      const execute = async () => {
        let recordsOnly = false;
        if (access.scope !== "local" && !command) {
          try {
            return await platformState(access, "GET");
          } catch (error) {
            // Only a missing capability selects the existing directory. Never mask
            // expired credentials, invalid responses, or a service outage as a mode change.
            if (
              !(error instanceof ApiError) ||
              error.code !== "timesheet_service_unavailable"
            )
              throw error;
            recordsOnly = true;
          }
        }
        if (access.scope !== "local" && !recordsOnly) {
          if (command?.type === "createInvoice") {
            const capabilities = await platformState(access, "GET");
            if (!capabilities.supportsInvoiceCreation)
              timeError("The connected firm has not enabled direct invoice creation.", 501);
            await assertIdentity(ctx, store, access);
          }
          const otherWorkers =
            command?.type === "create"
              ? (command.workerIds ?? []).filter(
                  (id) => id !== access.actor.userId,
                )
              : [];
          if (
            command &&
            (requiresTimeAllocations(command) || otherWorkers.length)
          ) {
            const current = await platformState(access, "GET");
            if (
              otherWorkers.some(
                (id) =>
                  !current.people.some(
                    (person) =>
                      person.id === id && person.canRecordTimeFor === true,
                  ),
              )
            )
              timeError(
                "Your firm has not delegated time entry for this person.",
                403,
              );
            if (
              requiresTimeAllocations(command) &&
              !current.supportsTimeAllocations
            )
              timeError(
                "The connected firm does not support split or per-participant time. Update its timesheet service before saving.",
                409,
              );
            await assertIdentity(ctx, store, access);
          }
          try {
            return await platformState(access, method, command);
          } catch (error) {
            remoteRejectedCreate = command?.type === "create" && error instanceof ApiError && error.code === "intake_invalid_request";
            throw error;
          }
        }
        const { people, workspaces } = await localDirectory(store, access);
        await assertIdentity(ctx, store, access);
        if (recordsOnly) {
          const state = readTimesheet(
            store,
            access.scope,
            access.actor,
            people,
            workspaces,
          );
          return {
            ...state,
            service: "records",
            canManage: false,
            canReview: false,
            supportsBillingComparisons: false,
            supportsTimeAllocations: false,
            invoiceDraft: undefined,
            entries: state.entries.filter((entry) => entry.legacy),
            delegatedEntries: [],
            adjustments: [],
            products: [],
            invoices: [],
            template: undefined,
          };
        }
        return command
          ? commandTimesheet(store, access.scope, access.actor, people, command, workspaces)
          : readTimesheet(store, access.scope, access.actor, people, workspaces);
      };
      const bookingIdentity = { user: access.actor.userId, scope: access.scope, principal: access.actor.principalKey ?? "",
        profileId: ctx.url.searchParams.get("profileId") };
      if (expectedDraft && (ctx.actor?.type !== "host" || !command || command.type !== "create"))
        timeError("Confirm the private draft on its local device.", 403);
      if (command?.type !== "create" || (command.source !== "suggestion" && !expectedDraft)) {
        return execute();
      }
      const authority: BookingAuthority<TimesheetState> = {
        request: command,
        resolve: async () => {
          await assertIdentity(ctx, store, access);
          const user = access.actor.userId, requestId = command.requestId;
          if (access.scope === "local") {
            const stored = readTimesheetRequest(store, access.scope, user, requestId);
            if (!stored) return "uncommitted";
            if (stored.kind !== "request") return;
            const { people, workspaces } = await localDirectory(store, access);
            await assertIdentity(ctx, store, access);
            return { booked: readTimesheet(store, access.scope, access.actor, people, workspaces) };
          }
          const state = await platformState(access, "GET");
          await assertIdentity(ctx, store, access);
          if (state.service === "records") return;
          if (state.entries.some(entry => entry.authorId === user && (entry.groupId === requestId || entry.id === requestId)) ||
              state.delegatedEntries?.some(entry => entry.groupId === requestId || entry.id === requestId)) return { booked: state };
          const entry = command.entry;
          const matter = state.matters.find(matter => matter.id === entry.matterId);
          const canSeeReferences = matter && (!entry.clientId || matter.clientIds.includes(entry.clientId)) &&
            (!entry.projectId || state.projects.some(project => project.id === entry.projectId));
          const canSeeGroup = !command.workerIds || command.workerIds.includes(user) || state.delegatedEntries !== undefined;
          const unidentifiedEntry = state.entries.some(row => !row.legacy && !row.groupId && row.authorId === user &&
            row.date === entry.date && row.matterId === entry.matterId);
          // A validation rejection on this exact POST plus the authorized read can disprove a prior commit.
          if (remoteRejectedCreate && canSeeReferences && canSeeGroup && !unidentifiedEntry) return "rejected";
        },
      };
      if (expectedDraft && command.source !== "suggestion")
        return bookPrivateManualDraft(config, bookingIdentity, command.requestId, expectedDraft, execute, "workflow", authority);
      if (!command.proposalDigest)
        timeError("A suggestion must reference its private original.");
      return acceptPrivateProposal(
        config,
        bookingIdentity,
        command.requestId,
        command.proposalDigest,
        execute,
        "workflow",
        expectedDraft,
        authority,
      );
    };
    route(method, "/timesheet", timesheet);
    route(method, "/workspace/:id/timekeeping/billing", timesheet);
  }
  route("GET", "/timesheet/adjustments/:id/document", async (ctx, store, access) => {
    await assertFinance(ctx, store, access);
    const id = z.uuid().parse(ctx.params.id);
    let document: string, number: string;
    if (access.scope === "local") {
      const canReadRecord = (id: string) => {
        const record = store.raw(access.scope, id);
        return record && !record.archivedAt && store.canRead(access.scope, record, access.actor);
      };
      const correction = readTimeDocument(store, access.scope, id);
      if (correction?.kind !== "adjustment" || !correction.document || !correction.value.noteNumber ||
          !correction.value.invoiceId || !canReadRecord(correction.value.matterId))
        timeError("The correction document is unavailable.", 404);
      const invoice = readTimeDocument(store, access.scope, correction.value.invoiceId);
      if (invoice?.kind !== "invoice" || !canReadRecord(invoice.value.clientId))
        timeError("The correction document is unavailable.", 404);
      document = correction.document;
      number = correction.value.noteNumber;
    } else {
      const result = z.object({ number: z.string().regex(/^[0-9]+-C[0-9]+$/), document: z.string() })
        .parse(await platform(access, "GET", "/adjustments/" + id + "/document"));
      document = result.document;
      number = result.number;
    }
    return new Response(document, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": 'attachment; filename="Correction-' + number + '.html"',
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });
}
