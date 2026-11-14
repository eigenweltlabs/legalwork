import { t } from "@/i18n";

// Map stored domain values to complete locale keys. Resolve the key at render time so
// changing the application language updates open ledgers and billing reviews.

export const ledgerColumnKeys = {
  date: "timesheets.ledger.date",
  matter: "timesheets.ledger.matter",
  workers: "timesheets.ledger.workers",
  activity: "timesheets.ledger.activity",
  narrative: "timesheets.ledger.narrative",
  product: "timesheets.ledger.product",
  worked: "timesheets.ledger.worked",
  charge: "timesheets.ledger.charge",
  billable: "timesheets.ledger.billable",
};

export const placeholderKeys = {
  date: "timesheets.ledger.placeholder.date",
  matter: "timesheets.ledger.placeholder.matter",
  workers: "timesheets.ledger.placeholder.workers",
  activity: "timesheets.ledger.placeholder.activity",
  narrative: "timesheets.ledger.placeholder.narrative",
  product: "timesheets.ledger.placeholder.product",
  worked: "timesheets.ledger.placeholder.worked",
  charge: "timesheets.ledger.placeholder.charge",
};

export const activityKeys: Readonly<Record<string, string | undefined>> = {
  RES: "timesheets.ledger.activity.RES",
  CF: "timesheets.ledger.activity.CF",
  EXM: "timesheets.ledger.activity.EXM",
  INM: "timesheets.ledger.activity.INM",
  EML: "timesheets.ledger.activity.EML",
  EMX: "timesheets.ledger.activity.EMX",
  EMI: "timesheets.ledger.activity.EMI",
  DFT: "timesheets.ledger.activity.DFT",
  MOD: "timesheets.ledger.activity.MOD",
  PLE: "timesheets.ledger.activity.PLE",
  LS: "timesheets.ledger.activity.LS",
  LL: "timesheets.ledger.activity.LL",
  STR: "timesheets.ledger.activity.STR",
  TEL: "timesheets.ledger.activity.TEL",
  DR: "timesheets.ledger.activity.DR",
  DDR: "timesheets.ledger.activity.DDR",
};

export const entryStatusKeys = {
  declined: "timesheets.ledger.status.declined",
  pending: "timesheets.ledger.status.pending",
  confirmed: "timesheets.ledger.status.confirmed",
  approved: "timesheets.ledger.status.approved",
  submitted: "timesheets.ledger.status.submitted",
  invoiced: "timesheets.ledger.status.invoiced",
};

export const historyActionKeys: Readonly<Record<string, string | undefined>> = {
  declineSuggestion: "timesheets.ledger.event.declineSuggestion",
  create: "timesheets.ledger.event.create",
  update: "timesheets.ledger.event.update",
  confirm: "timesheets.ledger.event.confirm",
  decline: "timesheets.ledger.event.decline",
  submit: "timesheets.ledger.event.submit",
  review: "timesheets.ledger.event.review",
  "return": "timesheets.ledger.event.return",
  approve: "timesheets.ledger.event.approve",
  invoice: "timesheets.ledger.event.invoice",
};

export const historyFieldKeys: Readonly<Record<string, string | undefined>> = {
  activityLabel: "timesheets.ledger.change.activityLabel",
  policyDigest: "timesheets.ledger.change.policyDigest",
  startAt: "timesheets.ledger.change.startAt",
  endAt: "timesheets.ledger.change.endAt",
  date: "timesheets.ledger.change.date",
  matterId: "timesheets.ledger.change.matterId",
  projectId: "timesheets.ledger.change.projectId",
  clientId: "timesheets.ledger.change.clientId",
  activity: "timesheets.ledger.change.activity",
  narrative: "timesheets.ledger.change.narrative",
  workedMinutes: "timesheets.ledger.change.workedMinutes",
  billable: "timesheets.ledger.change.billable",
  billableMinutes: "timesheets.ledger.change.billableMinutes",
  workProductId: "timesheets.ledger.change.workProductId",
  workProductTitle: "timesheets.ledger.change.workProductTitle",
  status: "timesheets.ledger.change.status",
  hourlyRate: "timesheets.ledger.change.hourlyRate",
  currency: "timesheets.ledger.change.currency",
};

export const roundingKeys = {
  choose: "back_office.billing.round_choose",
  up: "back_office.billing.round_up",
  down: "back_office.billing.round_down",
  nearest: "back_office.billing.round_nearest",
};

export const scopeKeys = {
  firm: "back_office.billing.scope_firm",
  client: "back_office.billing.scope_client",
  matter: "back_office.billing.scope_matter",
  project: "back_office.billing.scope_project",
};

export const reviewViewKeys = {
  adjustments: "back_office.billing.view_adjustments",
  submitted: "back_office.billing.view_submitted",
  approved: "back_office.billing.view_approved",
  invoices: "back_office.billing.view_invoices",
  costs: "back_office.billing.view_costs",
};

export const productTypeKeys = {
  document: "back_office.billing.kind_document",
  email: "back_office.billing.kind_email",
  pleading: "back_office.billing.kind_pleading",
  memo: "back_office.billing.kind_memo",
  letter: "back_office.billing.kind_letter",
  report: "back_office.billing.kind_report",
};

export const adjustmentStatusKeys = {
  pending: "back_office.billing.adjustment_pending",
  approved: "back_office.billing.adjustment_approved",
  declined: "back_office.billing.adjustment_declined",
};

export const impactKeys = {
  binding: "back_office.billing.change_binding",
  activity: "back_office.billing.change_activity",
  solo: "back_office.billing.change_solo",
  grid: "back_office.billing.change_grid",
  cap: "back_office.billing.change_cap",
  words: "back_office.billing.change_words",
  rate: "back_office.billing.change_rate",
  reviewer: "back_office.billing.change_reviewer",
  language: "back_office.billing.change_language",
};

export const sourceKeys = {
  documents: "timesheets.source.documents",
  gmail: "timesheets.source.gmail",
  outlook: "timesheets.source.outlook",
  "google-calendar": "timesheets.source.google-calendar",
  "outlook-calendar": "timesheets.source.outlook-calendar",
  calendar: "timesheets.calendar",
  tasks: "timesheets.tasks",
};

// Firms can add activity codes and older servers can emit additional history fields.
export function labelForCode(keys: Readonly<Record<string, string | undefined>>, code: string) {
  const key = Object.hasOwn(keys, code) ? keys[code] : undefined;
  return key ? t(key) : code;
}
