import { ApiError } from "../errors.js";
import type { BackOfficeModel } from "./schema.js";

// Publishing adds local extensions to the firm's model without replacing its definitions.
export function mergePublishModel(
  source: BackOfficeModel,
  team: BackOfficeModel,
): BackOfficeModel {
  const merged = structuredClone(team);
  for (const localObject of source.objects) {
    const object = merged.objects.find(
      (object) => object.id === localObject.id,
    );
    if (!object) {
      merged.objects.push(structuredClone(localObject));
      continue;
    }
    for (const localField of localObject.fields) {
      const field = object.fields.find((field) => field.id === localField.id);
      if (!field) {
        object.fields.push(structuredClone(localField));
        continue;
      }
      if (
        field.type !== localField.type ||
        field.target !== localField.target ||
        field.multiple !== localField.multiple ||
        field.visibility !== localField.visibility
      )
        throw new ApiError(
          409,
          "back_office_model",
          `${object.plural}: ${field.label} has a different local definition. Align the field definitions before publishing.`,
        );
      field.options = [...new Set([...field.options, ...localField.options])];
    }
  }
  return merged;
}
