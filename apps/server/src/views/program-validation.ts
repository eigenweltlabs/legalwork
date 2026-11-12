import type { ViewInput } from "@legalwork/types/views";
import { ApiError } from "../errors.js";
import { dashboardProgramErrors } from "./schema.js";

export function dashboardDiagnostics(input: ViewInput) {
  const bindings = [...Object.keys(input.queries), ...Object.keys(input.datasets ?? {})];
  const issues = dashboardProgramErrors(input.program, bindings);
  if (issues.length) return { issues: issues.slice(0, 20), issueCount: issues.length };
}

export function validateDashboardProgram(input: ViewInput) {
  const diagnostics = dashboardDiagnostics(input);
  if (!diagnostics) return;
  const summary = diagnostics.issues.slice(0, 8).map(issue =>
    [issue.statementId, issue.component, issue.message, issue.hint].filter(Boolean).join(" ")
  ).join("\n");
  throw new ApiError(400, "invalid_view_program",
    "Correct the dashboard program and retry the same tool and target.\n" + summary, diagnostics);
}
