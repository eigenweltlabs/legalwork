import {
  defaultBackOfficeModel,
  type BackOfficeObject,
} from "@legalwork/types/back-office";
import { t } from "@/i18n";
const defaults = defaultBackOfficeModel().objects;
const objectLabels = (): Record<string, { label: string; plural: string }> => ({
  matters: {
    label: t("back_office.matters.singular"),
    plural: t("back_office.matters.plural"),
  },
  clients: {
    label: t("back_office.clients.singular"),
    plural: t("back_office.clients.plural"),
  },
  people: {
    label: t("back_office.people.singular"),
    plural: t("back_office.people.plural"),
  },
  companies: {
    label: t("back_office.companies.singular"),
    plural: t("back_office.companies.plural"),
  },
  parties: {
    label: t("back_office.parties.singular"),
    plural: t("back_office.parties.plural"),
  },
  projectLinks: {
    label: t("back_office.projectLinks.singular"),
    plural: t("back_office.projectLinks.plural"),
  },
  feeAgreements: {
    label: t("back_office.feeAgreements.singular"),
    plural: t("back_office.feeAgreements.plural"),
  },
  timeEntries: {
    label: t("back_office.timeEntries.singular"),
    plural: t("back_office.timeEntries.plural"),
  },
  billingItems: {
    label: t("back_office.billingItems.singular"),
    plural: t("back_office.billingItems.plural"),
  },
  invoices: {
    label: t("back_office.invoices.singular"),
    plural: t("back_office.invoices.plural"),
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
// Translate shipped labels for display while preserving firm customizations.
export function displayBackOfficeObject(
  object: BackOfficeObject,
): BackOfficeObject {
  const baseline = defaults.find((item) => item.id === object.id);
  const labels = objectLabels()[object.id];
  if (!baseline || !labels) return object;
  return {
    ...object,
    label: object.label === baseline.label ? labels.label : object.label,
    plural:
      object.plural === baseline.plural ||
      (object.id === "clients" && object.plural === "Clients · Mandanten")
        ? labels.plural
        : object.plural,
  };
}
