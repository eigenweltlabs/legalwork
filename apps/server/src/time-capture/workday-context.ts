import {
  resolveTimePolicy,
  type TimePolicy,
  type TimesheetState,
} from "../back-office/timesheet-schema.js";
import type {
  CaptureProposal,
  WorkdayGuideline,
  WorkdayInstruction,
} from "@legalwork/types/time-capture";
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
import type { DraftRules, ModelEvidence } from "./reconstruct-workday.js";
import { extname } from "node:path";

export async function workdayWorkspaces(config: ServerConfig) {
  const links = await projectSyncStore(config);
  const orgId = connectedTaskOrgId(await readEigenweltConnection(config));
  return config.workspaces.filter((workspace) => {
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
  return readTimesheet(store, access.scope, access.actor, [], links);
}

export function visibleGuideline(
  guideline: WorkdayGuideline,
  state: Pick<TimesheetState, "clients" | "matters">,
) {
  if (guideline.scope === "firm") return guideline.targetId === "firm";
  return (guideline.scope === "client" ? state.clients : state.matters).some(
    (record) => record.id === guideline.targetId,
  );
}

function guidelineVersion(
  guidelines: WorkdayGuideline[],
  scope: "firm" | "client" | "matter",
  target?: string,
) {
  return guidelines
    .filter((item) => item.scope === scope && item.targetId === target)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.revision - a.revision ||
        a.id.localeCompare(b.id),
    )[0];
}

export function draftRules(
  state: TimesheetState,
  guidelines: WorkdayGuideline[],
  matter: TimesheetState["matters"][number],
  date: string,
  projectId?: string,
): DraftRules {
  const clientId = visibleSingleClient(matter, state) ?? "";
  const versions = effectiveWorkdayGuidelines(state, guidelines, {
    clientId,
    matterId: matter.id,
    date,
  });
  const guidelineInstructions: string[] = [];
  const privatePolicies: TimePolicy[] = versions.map((version) => {
    const {
      scope,
      targetId,
      effectiveFrom,
      revision,
      rules: { instructions, ...rules },
    } = version;
    if (instructions) guidelineInstructions.push(instructions);
    return { scope, targetId, effectiveFrom, revision, ...rules };
  });
  const {
    language,
    actionWords,
    narrativeCorrections,
    narrativeExample,
    actionFirst,
    activityLabels,
    minimumMinutes = 0,
    maxMinutes,
    activityLimits,
    incrementMinutes,
    enforceIncrement,
    rounding,
    stopwatchRoundUp,
  } = resolveTimePolicy(
    [...state.policies, ...privatePolicies],
    clientId,
    matter.id,
    date,
    projectId,
  );
  return {
    language,
    actionWords,
    narrativeCorrections,
    narrativeExample,
    actionFirst,
    activityLabels,
    guidelineInstructions,
    minimumMinutes,
    maxMinutes,
    activityLimits,
    incrementMinutes,
    enforceIncrement,
    rounding,
    stopwatchRoundUp,
  };
}

export function effectiveWorkdayGuidelines(
  state: TimesheetState,
  guidelines: WorkdayGuideline[],
  {
    clientId,
    matterId,
    date,
  }: { clientId: string; matterId: string; date: string },
  includeSupplemental = false,
) {
  const matter = state.matters.find((item) => item.id === matterId);
  if (!matter) return [];
  const client =
    matter.clientIds.includes(clientId) &&
    state.clients.some((item) => item.id === clientId)
      ? clientId
      : undefined;
  const eligible = guidelines.filter(
    (guideline) =>
      guideline.effectiveFrom <= date && visibleGuideline(guideline, state),
  );
  // An imported guideline is local drafting context. Published rules for the same scope take precedence.
  return [
    guidelineVersion(eligible, "firm", "firm"),
    guidelineVersion(eligible, "client", client),
    guidelineVersion(eligible, "matter", matter.id),
  ].flatMap((version) =>
    !version ||
    (!includeSupplemental &&
      state.policies.some(
        (policy) =>
          !policy.agreementId &&
          policy.scope === version.scope &&
          policy.targetId === version.targetId &&
          policy.effectiveFrom <= date,
      ))
      ? []
      : [version],
  );
}

function visibleSingleClient(
  matter: TimesheetState["matters"][number],
  state: TimesheetState,
) {
  if (
    matter.clientIds.length === 1 &&
    state.clients.some((client) => client.id === matter.clientIds[0])
  )
    return matter.clientIds[0];
}

export function captureMatter(
  proposal: CaptureProposal,
  state: TimesheetState,
) {
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
      workProduct: id.optional(),
      workProductId: id.optional(),
    }),
  }),
});

export function acceptedFileProduct(
  result: unknown,
  key: string,
  hash: string,
  worker: string,
) {
  const workflow = workflowReceipt.safeParse(result);
  if (workflow.success) {
    const entry = workflow.data.entries.find(
      (item) =>
        item.groupId === key &&
        item.proposalDigest === hash &&
        item.workerId === worker &&
        item.workProductId &&
        ["confirmed", "submitted", "approved", "invoiced"].includes(
          item.status,
        ),
    );
    if (
      entry?.workProductId &&
      workflow.data.products.some(
        (product) =>
          product.id === entry.workProductId &&
          product.matterId === entry.matterId,
      )
    )
      return { matterId: entry.matterId, workProductId: entry.workProductId };
  }
  const directory = directoryReceipt.safeParse(result);
  if (directory.success && directory.data.record.id === key) {
    const {
      matter,
      workProduct,
      workProductId = workProduct,
    } = directory.data.record.values;
    if (workProductId) return { matterId: matter, workProductId };
  }
}

function titleCorrection(text: string) {
  const match =
    /^(?:künftig\s+|from now on\s+)?["„“]?([\p{L}\p{N} ._-]{1,120}?)["”]?\s*(?:→|->)\s*["„“]?([\p{L}\p{N} ._-]{1,120}?)["”]?$/iu.exec(
      text.trim(),
    );
  if (match) return { from: match[1].trim(), to: match[2].trim() };
}

export function modelEvidence(
  evidence: WorkdayEvidence[],
  state: TimesheetState,
  guidelines: WorkdayGuideline[],
  instructions: WorkdayInstruction[],
  date: string,
  fileProducts: FileProducts = {},
): ModelEvidence[] {
  return evidence.flatMap((item) => {
    const p = item.proposal;
    const matter = captureMatter(p, state);
    // An explicit matter on an observation may have become inaccessible since capture.
    if (p.matterId && !matter) return [];
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
    const relevant = instructions.filter(
      (rule) =>
        rule.scope === "personal" ||
        (rule.scope === "matter" && !!matter && rule.matterId === matter.id) ||
        (rule.scope === "document" &&
          !!p.documentId &&
          rule.documentId === p.documentId &&
          (!rule.matterId || rule.matterId === matter?.id)),
    );
    const title =
      product?.name ??
      (p.source === "documents"
        ? p.narrative.slice(0, p.narrative.length - extname(p.narrative).length)
        : undefined);
    const terminology = relevant.flatMap((rule) => {
      const replacement =
        rule.scope === "document" && titleCorrection(rule.text);
      return replacement && replacement.from && replacement.to
        ? [replacement]
        : [];
    });
    const documentTitle = terminology.at(-1)?.to ?? title;
    return [
      {
        item: product
          ? { ...item, proposal: { ...p, workProductId: product.id } }
          : item,
        matter: matter ? { id: matter.id, name: matter.name } : undefined,
        documentTitle,
        terminology,
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
        instructions: relevant.map((rule) => rule.text),
      },
    ];
  });
}
