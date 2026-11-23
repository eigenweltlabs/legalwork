import { visibleTimekeepingProjects } from "./profile.js";
import {
  captureFileSource,
  type TimesheetState,
} from "../back-office/timesheet-schema.js";
import type {
  CaptureProposal,
  WorkdayGuideline,
} from "@legalwork/types/time-capture";
import { draftRules, visibleSingleClient } from "../back-office/timesheet-schema.js";
export { draftRules, visibleGuideline, effectiveWorkdayGuidelines } from "../back-office/timesheet-schema.js";
import { z } from "zod";
import {
  backOfficeAccess,
  backOfficeDirectoryIdentity,
} from "../back-office/access.js";
import { backOfficeStore } from "../back-office/store.js";
import {
  readTimesheet,
  timeWorkspaces,
} from "../back-office/timesheet-data.js";
import { readPlatformTimesheet } from "../back-office/timesheet-platform.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { projectSyncStore } from "../project-sync-store.js";
import { connectedTaskOrgId } from "../tasks-api.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import type { WorkdayEvidence } from "./private-workday.js";
import type { ModelEvidence } from "./reconstruct-workday.js";
import { extname } from "node:path";
import { matterTitleMatcher } from "./matter-title-match.js";

export async function workdayWorkspaces(config: ServerConfig) {
  const links = await projectSyncStore(config);
  const orgId = connectedTaskOrgId(await readEigenweltConnection(config));
  return (await visibleTimekeepingProjects(config)).filter((workspace) => {
    const link = links.linkByWorkspace(workspace.id);
    return !link || (link.orgId === orgId && link.state === "active");
  });
}

export async function workdayContext(
  config: ServerConfig,
  access: Awaited<ReturnType<typeof backOfficeAccess>>,
  workspaces: ServerConfig["workspaces"],
) {
  if (access.scope !== "local") {
    try {
      return await readPlatformTimesheet(config, access);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.code !== "timesheet_service_unavailable"
      )
        throw error;
    }
  }
  const store = await backOfficeStore(config);
  store.requireAccount(access.scope, access.actor);
  const directory = await backOfficeDirectoryIdentity(
    config,
    access.scope,
    store,
  );
  const links = await timeWorkspaces(workspaces, directory);
  const state = readTimesheet(store, access.scope, access.actor, [], links);
  if (access.scope !== "local") state.service = "records";
  return state;
}

export function captureMatter(
  proposal: CaptureProposal,
  state: TimesheetState,
) {
  if (proposal.source === "stopwatch") return state.matters.find(matter => matter.id === proposal.matterId);
  const linked = proposal.projectId
    ? state.projects.find((project) => project.id === proposal.projectId)
        ?.matterIds
    : undefined;
  const id =
    proposal.matterId ?? (linked?.length === 1 ? linked[0] : undefined);
  if (id && (!linked?.length || linked.includes(id)))
    return state.matters.find((matter) => matter.id === id);
}

export type FileProducts = Record<string, Record<string, string>>;

const id = z.string().min(1).max(200);
const workflowReceipt = z.object({
  entries: z.array(
    z.object({
      narrative: z.string().optional(),
      groupId: id.optional(),
      proposalDigest: z.string().optional(),
      workerId: id,
      matterId: id,
      workProductId: id.optional(),
      status: z.string(),
    }),
  ),
  products: z.array(z.object({ id, matterId: id })),
});
const directoryReceipt = z.object({
  record: z.object({
    id,
    objectId: z.literal("timeEntries"),
    values: z.object({
      matter: id,
      billingNarrative: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      workProduct: id.nullable().optional(),
      workProductId: id.nullable().optional(),
    }),
  }),
});

export function acceptedDocumentEntry(result: unknown, key: string, hash: string, worker: string) {
  const workflow = workflowReceipt.safeParse(result);
  if (workflow.success) {
    const entry = workflow.data.entries.find(item => item.groupId === key && item.proposalDigest === hash &&
      item.workerId === worker && ["confirmed", "submitted", "approved", "invoiced"].includes(item.status));
    if (entry) return {
      matterId: entry.matterId,
      narrative: entry.narrative,
      workProductId: workflow.data.products.some(product => product.id === entry.workProductId &&
        product.matterId === entry.matterId) ? entry.workProductId : undefined,
    };
  }
  const directory = directoryReceipt.safeParse(result);
  if (directory.success && directory.data.record.id === key) {
    const { matter, workProduct, workProductId = workProduct, billingNarrative, name } = directory.data.record.values;
    return { matterId: matter, workProductId: workProductId ?? undefined, narrative: billingNarrative || name };
  }
}

export function acceptedFileProduct(result: unknown, key: string, hash: string, worker: string) {
  const entry = acceptedDocumentEntry(result, key, hash, worker);
  if (entry?.workProductId) return { matterId: entry.matterId, workProductId: entry.workProductId };
}

export function modelEvidence(
  evidence: WorkdayEvidence[],
  state: TimesheetState,
  guidelines: WorkdayGuideline[],
  date: string,
  fileProducts: FileProducts = {},
): ModelEvidence[] {
  const fromTitle = matterTitleMatcher(state);
  return evidence.flatMap((item) => {
    const p = item.proposal;
    const linked = captureMatter(p, state);
    // An explicit matter on an observation may have become inaccessible since capture.
    if ((p.matterId || p.source === "stopwatch") && !linked) return [];
    const candidate = !linked ? fromTitle(p) : undefined;
    const matter = linked ?? candidate?.matter;
    const client = matter && visibleSingleClient(matter, state);
    const bound =
      p.documentId && matter
        ? fileProducts[p.documentId]?.[matter.id]
        : undefined;
    const docs =
      p.documentId && matter
        ? state.products.filter(
            (product) =>
              product.matterId === matter.id &&
              (bound
                ? product.id === bound
                : product.id === p.documentId ||
                  product.reference === p.documentId),
          )
        : [];
    const product = docs.length === 1 ? docs[0] : undefined;
    const history =
      product && client
        ? state.entries
            .filter(
              (entry) =>
                entry.workProductId === product.id &&
                entry.matterId === matter?.id &&
                entry.clientId === client &&
                entry.date < date &&
                ["confirmed", "submitted", "approved", "invoiced"].includes(
                  entry.status,
                ),
            )
            .sort(
              (a, b) =>
                b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
            )
            .slice(0, 4)
            .map((entry) => entry.narrative)
        : [];
    const title =
      product?.name ??
      (p.source === "documents" || captureFileSource(p.source)
        ? p.narrative.slice(0, p.narrative.length - extname(p.narrative).length)
        : undefined);
    return [
      {
        item: product
          ? { ...item, proposal: { ...p, workProductId: product.id } }
          : item,
        matter: matter ? { id: matter.id, name: matter.name } : undefined,
        matterMatch: candidate?.basis,
        documentTitle: title,
        sourceDocumentTitle: title,
        history: history.length ? history : undefined,
        rules: matter
          ? draftRules(
              state,
              guidelines,
              matter,
              date,
              p.projectId ?? undefined,
            )
          : undefined,

      },
    ];
  });
}
