import {
  defaultBackOfficeModel,
  type BackOfficeObject,
  type BackOfficeField,
} from "@legalwork/types/back-office";
import { LANGUAGES, t, type Language } from "@/i18n";
const defaults = defaultBackOfficeModel().objects;
const defaultFields = defaults.flatMap(object => object.fields);
const objectLabels = (language?: Language): Record<string, { label: string; plural: string }> => ({
  matters: {
    label: t("back_office.matters.singular", language),
    plural: t("back_office.matters.plural", language),
  },
  clients: {
    label: t("back_office.clients.singular", language),
    plural: t("back_office.clients.plural", language),
  },
  people: {
    label: t("back_office.people.singular", language),
    plural: t("back_office.people.plural", language),
  },
  companies: {
    label: t("back_office.organisations.singular", language),
    plural: t("back_office.organisations.plural", language),
  },
  parties: {
    label: t("back_office.parties.singular", language),
    plural: t("back_office.parties.plural", language),
  },
  projectLinks: {
    label: t("back_office.projectLinks.singular", language),
    plural: t("back_office.projectLinks.plural", language),
  },
  feeAgreements: {
    label: t("back_office.feeAgreements.singular", language),
    plural: t("back_office.feeAgreements.plural", language),
  },
  timeEntries: {
    label: t("back_office.timeEntries.singular", language),
    plural: t("back_office.timeEntries.plural", language),
  },
  billingItems: {
    label: t("back_office.billingItems.singular", language),
    plural: t("back_office.billingItems.plural", language),
  },
  invoices: {
    label: t("back_office.invoices.singular", language),
    plural: t("back_office.invoices.plural", language),
  },
});
export const backOfficeObjectLabel = (id: string) =>
  objectLabels()[id]?.plural ?? id;
export const backOfficeViewLabel = (type: string) => {
  const labels: Record<string, string> = {
    table: t("back_office.table"),
    kanban: t("back_office.kanban"),
    calendar: t("back_office.calendar"),
    list: t("back_office.list"),
  };
  return labels[type] ?? type;
};
export const backOfficeIconLabel = (icon: string) => {
  const labels: Record<string, string> = {
    table: t("back_office.icon.table"),
    kanban: t("back_office.icon.kanban"),
    calendar: t("back_office.icon.calendar"),
    list: t("back_office.icon.list"),
    briefcase: t("back_office.icon.briefcase"),
    building: t("back_office.icon.building"),
    users: t("back_office.icon.users"),
    tag: t("back_office.icon.tag"),
  };
  return labels[icon] ?? icon;
};
// Match both shipped languages so saved defaults follow language changes.
// Only display copies are translated; record values and firm labels stay intact.
const fieldTranslationKeys: Record<string, string> = {
  "Name": "plugin_create.name",
  "Type": "mcp.server_type",
  "Email": "calendar.email_reminder",
  "File number": "back_office.field.file_number",
  "Clients": "back_office.clients.plural",
  "Status": "catalog.status",
  "Practice area": "projects.schema.practice_area",
  "Lead lawyer": "back_office.field.lead_lawyer",
  "Opened": "back_office.field.opened",
  "Parent matter": "back_office.field.parent_matter",
  "Alternative reference": "back_office.field.alternative_reference",
  "Department": "projects.schema.department",
  "Value in dispute": "back_office.field.value_in_dispute",
  "Subject": "back_office.field.subject",
  "Tags": "native.tags",
  "Client number": "back_office.field.client_number",
  "Organisation": "back_office.organisations.singular",
  "Person": "back_office.people.singular",
  "Billing address": "back_office.field.billing_address",
  "Billing email": "back_office.field.billing_email",
  "E-invoice buyer reference": "back_office.field.e_invoice_buyer_reference",
  "Active": "calendar.active",
  "Phone": "back_office.field.phone",
  "Job title": "back_office.field.job_title",
  "Address": "storage.field_host",
  "City": "back_office.field.city",
  "Salutation": "back_office.field.salutation",
  "Birth date": "back_office.field.birth_date",
  "Nationality": "back_office.field.nationality",
  "Tax number": "back_office.field.tax_number",
  "Organisation type": "back_office.field.organisation_type",
  "Domain name": "back_office.field.domain_name",
  "Industry": "back_office.field.industry",
  "Registration number": "back_office.field.registration_number",
  "Legal form": "back_office.field.legal_form",
  "VAT ID": "back_office.field.vat_id",
  "Primary contact": "back_office.field.primary_contact",
  "Matter": "back_office.matters.singular",
  "Role": "back_office.field.role",
  "Client account": "back_office.field.client_account",
  "Party reference": "back_office.field.party_reference",
  "Subrole": "back_office.field.subrole",
  "Project ID": "storage.field_projectId",
  "Client": "projects.schema.client",
  "Signed agreement": "back_office.field.signed_agreement",
  "Fee basis": "back_office.field.fee_basis",
  "Hourly rate": "back_office.field.hourly_rate",
  "Flat fee": "back_office.field.flat_fee",
  "Included minutes": "back_office.field.included_minutes",
  "Billing increment (min)": "back_office.field.billing_increment_min",
  "Terms": "back_office.field.terms",
  "Timekeeper": "back_office.field.timekeeper",
  "Started at": "back_office.field.started_at",
  "Ended at": "back_office.field.ended_at",
  "Recorded minutes": "back_office.field.recorded_minutes",
  "Billable minutes": "back_office.field.billable_minutes",
  "Private work note": "back_office.field.private_work_note",
  "Billing narrative": "back_office.field.billing_narrative",
  "Invoice": "back_office.invoices.singular",
  "Item type": "back_office.field.item_type",
  "Service date": "back_office.field.service_date",
  "Description": "native.description",
  "Quantity": "back_office.field.quantity",
  "Net amount": "back_office.field.net_amount",
  "VAT (%)": "back_office.field.vat",
  "Invoice PDF": "back_office.field.invoice_pdf",
  "Invoice number": "back_office.field.invoice_number",
  "Issue date": "back_office.field.issue_date",
  "Due date": "back_office.field.due_date",
  "Net total": "back_office.field.net_total",
  "Gross total": "back_office.field.gross_total",
  "Outstanding": "back_office.field.outstanding",
  "Original invoice": "back_office.field.original_invoice"
};
const optionTranslationKeys: Record<string, string> = {
  "Intake": "back_office.option.intake",
  "Active": "calendar.active",
  "On hold": "back_office.option.on_hold",
  "Closed": "projects.schema.status_closed",
  "Corporate / M&A": "back_office.option.corporate_m_a",
  "Employment": "back_office.option.employment",
  "Commercial": "back_office.option.commercial",
  "Disputes": "back_office.option.disputes",
  "Privacy": "settings.privacy_title",
  "Real estate": "back_office.option.real_estate",
  "Other": "back_office.option.other",
  "Partner": "back_office.option.partner",
  "Counsel": "back_office.option.counsel",
  "Associate": "back_office.option.associate",
  "Assistant": "back_office.option.assistant",
  "Operations": "back_office.option.operations",
  "Freelancer": "back_office.option.freelancer",
  "Other team member": "back_office.option.other_team_member",
  "External contact": "back_office.option.external_contact",
  "Company": "back_office.option.company",
  "Court": "calc.court",
  "Public authority": "back_office.option.public_authority",
  "Law firm": "back_office.option.law_firm",
  "Association / nonprofit": "back_office.option.association_nonprofit",
  "Client": "projects.schema.client",
  "Billing recipient": "back_office.option.billing_recipient",
  "Counterparty": "back_office.option.counterparty",
  "Insurer": "back_office.option.insurer",
  "Contact": "back_office.option.contact",
  "Hourly": "back_office.option.hourly",
  "Flat fee": "back_office.option.flat_fee",
  "Flat fee with included time": "back_office.option.flat_fee_with_included_time",
  "RVG": "back_office.option.rvg",
  "Draft": "review.draft",
  "Submitted": "back_office.option.submitted",
  "Approved": "back_office.option.approved",
  "Invoiced": "back_office.option.invoiced",
  "Written off": "back_office.option.written_off",
  "Own expense": "back_office.option.own_expense",
  "Third-party expense": "back_office.option.third_party_expense",
  "Issued": "back_office.option.issued",
  "Part paid": "back_office.option.part_paid",
  "Paid": "back_office.option.paid",
  "Cancelled": "back_office.option.cancelled",
  "Credited": "back_office.option.credited"
};
const shippedFieldLabel = (field: BackOfficeField, baseline: BackOfficeField) => {
  const key = fieldTranslationKeys[baseline.label];
  return field.label === baseline.label || Boolean(key && LANGUAGES.some(language => field.label === t(key, language)));
};

export function displayBackOfficeField(field: BackOfficeField, objectId: string): BackOfficeField {
  const baseline = defaults.find(object => object.id === objectId)?.fields.find(item => item.id === field.id && item.type === field.type);
  const key = baseline && fieldTranslationKeys[baseline.label];
  return baseline && key && shippedFieldLabel(field, baseline) ? { ...field, label: t(key) } : field;
}

export function backOfficeOptionLabel(field: BackOfficeField, value: string): string {
  const baseline = defaultFields.find(item => item.id === field.id && item.type === field.type &&
    shippedFieldLabel(field, item) && item.options.length === field.options.length && item.options.every((option, index) => option === field.options[index]));
  const key = baseline && optionTranslationKeys[value];
  return key ? t(key) : value;
}

export function displayBackOfficeObject(object: BackOfficeObject): BackOfficeObject {
  const baseline = defaults.find(item => item.id === object.id);
  const labels = objectLabels()[object.id];
  if (!baseline || !labels) return object;
  const shippedLabels = LANGUAGES.map(language => objectLabels(language)[object.id]);
  return {
    ...object,
    label: object.label === baseline.label || shippedLabels.some(item => item.label === object.label) ||
      (object.id === "companies" && object.label === "Company") ? labels.label : object.label,
    plural: object.plural === baseline.plural || shippedLabels.some(item => item.plural === object.plural) ||
      (object.id === "clients" && object.plural === "Clients · Mandanten") ||
      (object.id === "companies" && object.plural === "Companies") ? labels.plural : object.plural,
    fields: object.fields.map(field => displayBackOfficeField(field, object.id)),
  };
}

const fieldTypeTranslationKeys: Record<BackOfficeField["type"], string> = {
  "text": "wiki.property_text",
  "number": "review.number",
  "boolean": "back_office.field_type.boolean",
  "datetime": "back_office.field_type.datetime",
  "date": "review.date",
  "select": "back_office.field_type.select",
  "multiselect": "back_office.field_type.multiselect",
  "currency": "back_office.filters.currency",
  "email": "calendar.email_reminder",
  "file": "assistant.file",
  "relation": "back_office.field_type.relation"
};
export const backOfficeFieldTypeLabel = (type: BackOfficeField["type"]) => t(fieldTypeTranslationKeys[type]);
