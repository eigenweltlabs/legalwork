import {
  defaultBackOfficeModel,
  type BackOfficeObject,
} from "@legalwork/types/back-office";
import { t } from "@/i18n";

const defaults = defaultBackOfficeModel().objects;

// Translate shipped labels for display. Firm customizations stay verbatim in the model.
export function displayBackOfficeObject(
  object: BackOfficeObject,
): BackOfficeObject {
  const baseline = defaults.find((item) => item.id === object.id);
  if (!baseline) return object;
  return {
    ...object,
    label:
      object.label === baseline.label
        ? t(`back_office.${object.id}.singular`)
        : object.label,
    plural:
      object.plural === baseline.plural ||
      (object.id === "clients" && object.plural === "Clients · Mandanten")
        ? t(`back_office.${object.id}.plural`)
        : object.plural,
  };
}
