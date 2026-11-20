import {
  acceptPrivateProposal,
  captureProfile,
} from "../time-capture/routes.js";
import { z } from "zod";
import {
  requiresTimeAllocations,
  TimesheetCommandSchema,
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
import {
  readLocalInvoiceGuidelines,
  withLocalInvoiceGuidelines,
  type InvoiceGuidelineContext,
} from "./timesheet-invoice-guidelines.js";
import { generateInvoiceWordingReview } from "./timesheet-invoice-wording.js";
import {
  draftOutput,
  issuedArtifacts,
  invoiceAttachment,
} from "./invoice-artifacts.js";
import {
  renderWordInvoice,
  convertInvoicePdf,
  validateWordTemplate,
} from "./invoice-word.js";
import { readInvoiceDraft } from "./timesheet-data.js";
import {
  invoiceTemplateSchema,
  requiresInvoiceDrafts,
} from "./timesheet-schema.js";
import { commandTimesheet, currentInvoiceDraft } from "./timesheet.js";
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
      timeError("The connected directory changed. Reopen this timesheet.", 409);
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
  function privateBilling(ctx: RequestContext, access: Access) {
    return (
      access.scope === "local" &&
      ctx.actor?.type === "host" &&
      !ctx.agentAccess &&
      !access.actor.agentId &&
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.host)
    );
  }
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
    route(method, "/timesheet", async (ctx, store, access) => {
      const command =
        method === "POST"
          ? TimesheetCommandSchema.parse(await input(ctx))
          : undefined;
      await assertIdentity(ctx, store, access);
      if (command && (ctx.agentAccess || access.actor.agentId))
        timeError(
          "A person must save or confirm billing workflow changes.",
          403,
        );
      if (command?.type === "invoice")
        timeError("Prepare and approve the invoice before issuing.", 409);
      if (command?.type === "template" && command.template.word) {
        if (!access.actor.finance)
          timeError("Billing access is required.", 403);
        validateWordTemplate(command.template);
      }
      if (
        command?.type === "submit" &&
        command.entries.some((entry) => entry.shareOriginal)
      )
        timeError(
          "Only the confirmed billing entry can be submitted. Private proposals stay on this device.",
          403,
        );
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
          if (
            command &&
            (command.type === "reviewInvoiceWording" ||
              requiresInvoiceDrafts(command) ||
              (command.type === "template" && command.template.word))
          ) {
            const capabilities = await platformState(access, "GET");
            if (
              command.type === "reviewInvoiceWording" &&
              !capabilities.supportsInvoiceWordingReview
            )
              timeError(
                "The connected firm has not enabled invoice wording review.",
                501,
              );
            if (!capabilities.supportsInvoiceDrafts)
              timeError(
                "The connected firm has not enabled invoice drafts, partner approval and document output.",
                501,
              );
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
          return platformState(access, method, command);
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
            supportsInvoiceWordingReview: false,
            supportsInvoiceDrafts: false,
            invoiceDraft: undefined,
            entries: state.entries.filter((entry) => entry.legacy),
            delegatedEntries: [],
            adjustments: [],
            products: [],
            invoices: [],
            template: undefined,
          };
        }
        const privateContext = privateBilling(ctx, access);
        const activeProfile = privateContext
          ? (await captureProfile(config, access)).profileId
          : undefined;
        const readCurrent = async () => {
          const context = privateContext
            ? await readLocalInvoiceGuidelines(config, access)
            : undefined;
          if (context?.profileId !== activeProfile)
            timeError("The active account changed.", 409);
          await assertFinance(ctx, store, access);
          return {
            state: readTimesheet(
              store,
              access.scope,
              access.actor,
              people,
              workspaces,
              true,
              context?.profileId,
            ),
            context,
          };
        };
        const advice =
          command?.type === "reviewInvoiceWording"
            ? await generateInvoiceWordingReview(
                config,
                store,
                access.actor,
                command,
                readCurrent,
                ctx.request.signal,
              )
            : undefined;
        const commit = async (context?: InvoiceGuidelineContext) => {
          await assertIdentity(ctx, store, access);
          if (context?.profileId !== activeProfile)
            timeError("The active account changed.", 409);
          return command
            ? commandTimesheet(
                store,
                access.scope,
                access.actor,
                people,
                command,
                workspaces,
                advice,
                context,
              )
            : readTimesheet(
                store,
                access.scope,
                access.actor,
                people,
                workspaces,
                false,
                activeProfile,
              );
        };
        const result =
          privateContext && command && requiresInvoiceDrafts(command)
            ? await withLocalInvoiceGuidelines(config, access, commit)
            : await commit(
                activeProfile
                  ? { profileId: activeProfile, versions: [] }
                  : undefined,
              );
        if (command?.type === "issueInvoice") {
          const invoice = result.invoices.find(
            (row) => row.draftId === command.id,
          );
          const stored =
            invoice && readTimeDocument(store, access.scope, invoice.id);
          if (!stored || stored.kind !== "invoice")
            timeError("The issued invoice is unavailable.", 404);
          await issuedArtifacts(store, access.scope, stored.value);
          await assertIdentity(ctx, store, access);
        }
        return result;
      };
      if (command?.type !== "create" || command.source !== "suggestion")
        return execute();
      if (!command.proposalDigest)
        timeError("A suggestion must reference its private original.");
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
  route("POST", "/timesheet/template-preview", async (ctx, store, access) => {
    await assertFinance(ctx, store, access);
    if (!access.actor.finance || ctx.agentAccess || access.actor.agentId)
      timeError("Billing access is required.", 403);
    const template = invoiceTemplateSchema.parse(await input(ctx));
    if (access.scope !== "local") {
      const response = z
        .object({ format: z.literal("pdf"), contentBase64: z.string().min(4) })
        .parse(await platform(access, "POST", "/template-preview", template));
      await assertFinance(ctx, store, access);
      return invoiceAttachment(
        "pdf",
        Buffer.from(response.contentBase64, "base64"),
        "Template",
      );
    }
    const pdf = await convertInvoicePdf(validateWordTemplate(template));
    await assertFinance(ctx, store, access);
    return invoiceAttachment("pdf", pdf, "Template");
  });
  {
    route(
      "GET",
      "/timesheet/drafts/:id/document",
      async (ctx, store, access) => {
        await assertFinance(ctx, store, access);
        if (!access.actor.finance)
          timeError("Billing access is required.", 403);
        const id = z.uuid().parse(ctx.params.id),
          format = z
            .enum(["docx", "pdf"])
            .parse(ctx.url.searchParams.get("format"));
        if (access.scope !== "local") {
          const remote = z
            .object({
              format: z.literal(format),
              contentBase64: z.string().min(4),
            })
            .parse(
              await platform(
                access,
                "GET",
                "/drafts/" + id + "/document?format=" + format,
              ),
            );
          await assertFinance(ctx, store, access);
          return invoiceAttachment(
            format,
            Buffer.from(remote.contentBase64, "base64"),
            "Draft",
          );
        }
        const current = async () => {
          const { people, workspaces } = await localDirectory(store, access);
          await assertFinance(ctx, store, access);
          const context = privateBilling(ctx, access)
            ? await readLocalInvoiceGuidelines(config, access)
            : undefined;
          const stored = readInvoiceDraft(
            store,
            access.scope,
            access.actor.userId,
            context?.profileId,
          );
          if (!stored || stored.id !== id)
            timeError("The invoice draft is unavailable.", 404);
          return currentInvoiceDraft(
            store,
            readTimesheet(
              store,
              access.scope,
              access.actor,
              people,
              workspaces,
              true,
              context?.profileId,
            ),
            access.actor,
            stored,
            context,
          );
        };
        const draft = await current(),
          word = renderWordInvoice(draftOutput(draft));
        const bytes = format === "pdf" ? await convertInvoicePdf(word) : word;
        if ((await current()).revision !== draft.revision)
          timeError("The invoice draft changed. Open its preview again.", 409);
        return invoiceAttachment(format, bytes, "Draft");
      },
    );
  }
  for (const kind of ["invoices", "adjustments"] as const)
    route(
      "GET",
      "/timesheet/" + kind + "/:id/document",
      async (ctx, store, access) => {
        await assertIdentity(ctx, store, access);
        if (!access.actor.finance)
          timeError("Billing access is required.", 403);
        const id = z.uuid().parse(ctx.params.id),
          isInvoice = kind === "invoices";
        const format = z
          .enum(["html", "docx", "pdf"])
          .parse(ctx.url.searchParams.get("format") ?? "html");
        if (!isInvoice && format !== "html")
          timeError("This correction is available as HTML.", 404);
        if (isInvoice && format !== "html" && access.scope !== "local") {
          const remote = z
            .object({
              number: z.number().int().positive(),
              format: z.literal(format),
              contentBase64: z.string().min(4),
            })
            .parse(
              await platform(
                access,
                "GET",
                "/invoices/" + id + "/document?format=" + format,
              ),
            );
          await assertFinance(ctx, store, access);
          return invoiceAttachment(
            format,
            Buffer.from(remote.contentBase64, "base64"),
            String(remote.number),
          );
        }
        let document: string, number: string;
        if (access.scope !== "local") {
          const result = z
            .object({
              number: z.union([
                z.number().int().positive(),
                z.string().regex(/^[0-9]+-C[0-9]+$/),
              ]),
              document: z.string(),
            })
            .parse(
              await platform(
                access,
                "GET",
                "/" + kind + "/" + id + "/document",
              ),
            );
          document = result.document;
          number = String(result.number);
        } else {
          const d = readTimeDocument(store, access.scope, id);
          const canReadRecord = (id: string) => {
            const m = store.raw(access.scope, id);
            return (
              m && !m.archivedAt && store.canRead(access.scope, m, access.actor)
            );
          };
          if (
            isInvoice &&
            d?.kind === "invoice" &&
            canReadRecord(d.value.clientId) &&
            d.value.entries.every((e) => canReadRecord(e.matterId))
          ) {
            if (format !== "html") {
              const pair = await issuedArtifacts(store, access.scope, d.value);
              await assertFinance(ctx, store, access);
              if (
                !canReadRecord(d.value.clientId) ||
                d.value.entries.some((row) => !canReadRecord(row.matterId))
              )
                timeError("The issued document is unavailable.", 404);
              return invoiceAttachment(
                format,
                pair[format],
                String(d.value.number),
              );
            }
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
            const original = readTimeDocument(
              store,
              access.scope,
              d.value.invoiceId,
            );
            if (
              original?.kind !== "invoice" ||
              !canReadRecord(original.value.clientId)
            )
              timeError("The issued document is unavailable.", 404);
            document = d.document;
            number = d.value.noteNumber;
          } else timeError("The issued document is unavailable.", 404);
        }
        return new Response(document, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-disposition":
              'attachment; filename="' +
              (isInvoice ? "Invoice-" : "Correction-") +
              number +
              '.html"',
            "content-security-policy":
              "sandbox; default-src 'none'; style-src 'unsafe-inline'",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          },
        });
      },
    );
}
