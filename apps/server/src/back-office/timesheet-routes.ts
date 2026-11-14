import { acceptPrivateProposal } from "../time-capture/routes.js";
import { z } from "zod";
import { TimesheetCommandSchema, TimesheetStateSchema } from "@legalwork/types/timesheet";
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

type Access = Awaited<ReturnType<typeof backOfficeAccess>>;
type Handler = (ctx: RequestContext, store: BackOfficeStore, access: Access) => Promise<unknown>;

export function registerTimesheetRoutes(
  config: ServerConfig,
  route: (method: string, path: string, action: Handler) => void,
  input: (ctx: RequestContext) => Promise<unknown>,
) {
  async function assertIdentity(ctx: RequestContext, store: BackOfficeStore, { scope, actor }: Access) {
    const query = ctx.url.searchParams;
    if (
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
      if (error instanceof ApiError && (error.status === 404 || error.code === "intake_bad_response"))
        timeError("Shared timesheets are not available on the connected firm server.", 503);
      throw error;
    }
  }
  for (const method of ["GET", "POST"]) {
    route(method, "/timesheet", async (ctx, store, access) => {
      const command = method === "POST" ? TimesheetCommandSchema.parse(await input(ctx)) : undefined;
      await assertIdentity(ctx, store, access);
      if (command && (ctx.agentAccess || access.actor.agentId))
        timeError("A person must save or confirm billing workflow changes.", 403);
      const execute = async () => {
        if (access.scope !== "local") {
          const raw = await platform(access, method, "", command),
            result = TimesheetStateSchema.safeParse(raw);
          if (
            !result.success ||
            result.data.userId !== access.actor.userId ||
            result.data.scope !== access.scope
          )
            timeError("The connected firm server did not return this account’s timesheet.", 502);
          return result.data;
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
            return { id: w.id, name: w.displayName || w.name, matterIds };
          }),
        );
        await assertIdentity(ctx, store, access);
        const people = [{ id: access.actor.userId, name: "Local user" }];
        return command
          ? commandTimesheet(store, access.scope, access.actor, people, command, workspaces)
          : readTimesheet(store, access.scope, access.actor, people, workspaces);
      };
      if (command?.type !== "create" || command.source !== "suggestion") return execute();
      if (!command.proposalDigest) timeError("A suggestion must reference its private original.");
      return acceptPrivateProposal(
        config,
        { user: access.actor.userId, scope: access.scope, principal: access.actor.principalKey ?? "" },
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
        const canReadMatter = (id: string) => {
          const m = store.raw(access.scope, id);
          return m && store.canRead(access.scope, m, access.actor);
        };
        if (
          isInvoice &&
          d?.kind === "invoice" &&
          d.value.entries.every((e) => canReadMatter(e.matterId))
        ) {
          document = d.document;
          number = String(d.value.number);
        } else if (
          !isInvoice &&
          d?.kind === "adjustment" &&
          d.document &&
          d.value.noteNumber &&
          canReadMatter(d.value.matterId)
        ) {
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
