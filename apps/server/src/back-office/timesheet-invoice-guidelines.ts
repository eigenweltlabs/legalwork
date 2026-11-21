import type { WorkdayGuideline } from "@legalwork/types/time-capture";
import {
  appliedTimePolicies,
  resolveTimePolicy,
  type TimeEntry,
  type TimesheetState,
} from "./timesheet-schema.js";
import { withFileWriteLock } from "../file-write-lock.js";
import {
  captureProfile,
  readCaptureGuidelines,
} from "../time-capture/routes.js";
import { effectiveWorkdayGuidelines } from "../time-capture/workday-context.js";
import type { ServerConfig } from "../types.js";
import type { backOfficeAccess } from "./access.js";
import { timeError } from "./timesheet-data.js";

type Access = Awaited<ReturnType<typeof backOfficeAccess>>;
export type InvoiceGuidelineContext = {
  profileId: string;
  versions: WorkdayGuideline[];
};

export async function readLocalInvoiceGuidelines(
  config: ServerConfig,
  access: Access,
) {
  const profile = await captureProfile(config, access);
  const versions = await readCaptureGuidelines(profile.path);
  if ((await captureProfile(config, access)).profileId !== profile.profileId)
    timeError(
      "The private billing guidelines changed accounts. Reopen the invoice draft.",
      409,
    );
  return { profileId: profile.profileId, versions };
}

export async function withLocalInvoiceGuidelines<T>(
  config: ServerConfig,
  access: Access,
  commit: (context: InvoiceGuidelineContext) => Promise<T>,
) {
  const profile = await captureProfile(config, access);
  // Uploads use the same lock. Check the private version and finish the synchronous invoice mutation before releasing it.
  return withFileWriteLock(profile.path, async () => {
    const versions = await readCaptureGuidelines(profile.path);
    if ((await captureProfile(config, access)).profileId !== profile.profileId)
      timeError(
        "The private billing guidelines changed accounts. Reopen the invoice draft.",
        409,
      );
    return commit({ profileId: profile.profileId, versions });
  });
}

export function invoiceWordingRules(
  state: TimesheetState,
  {
    clientId,
    matterId,
    date,
    projectId,
  }: Pick<TimeEntry, "clientId" | "matterId" | "date" | "projectId">,
  context?: InvoiceGuidelineContext,
) {
  const versions = context
    ? effectiveWorkdayGuidelines(
        state,
        context.versions,
        { clientId, matterId, date },
      )
    : [];
  const policy = resolveTimePolicy(
    state.policies,
    clientId,
    matterId,
    date,
    projectId,
  );
  const checks = {
    language: policy.language,
    actionWords: { ...policy.actionWords },
    actionFirst: policy.actionFirst,
    narrativeCorrections: { ...policy.narrativeCorrections },
    narrativeExample: policy.narrativeExample,
    activityLabels: policy.activityLabels,
  };
  const targets = {
    firm: "firm",
    client: clientId,
    matter: matterId,
    project: projectId,
  };
  for (const scope of ["firm", "client", "matter", "project"] as const) {
    const published = appliedTimePolicies(
      state.policies,
      scope,
      targets[scope],
      date,
      clientId,
      projectId,
    );
    const imported = versions.find((version) => version.scope === scope)?.rules;
    for (const rule of imported ? [imported, ...published] : published) {
      if (rule.language !== undefined) checks.language = rule.language;
      if (rule.actionFirst !== undefined) checks.actionFirst = rule.actionFirst;
      if (rule.narrativeExample !== undefined)
        checks.narrativeExample = rule.narrativeExample;
      Object.assign(checks.actionWords, rule.actionWords);
      Object.assign(checks.narrativeCorrections, rule.narrativeCorrections);
    }
  }
  return { policy, wording: { ...policy, ...checks }, versions };
}
