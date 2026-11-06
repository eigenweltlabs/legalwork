import type { Applikation } from "../types.js";
import { RisValidationError } from "../infrastructure/errors.js";
import { classifyId } from "./content.js";
import { BundeslandEnum } from "../schemas/enums.js";

/** Landesgesetz numbers are local to each state, not unique across LrKons. */
export function requireStateDocumentId(app: Applikation, id: string): void {
  if (app === "LrKons" && classifyId(id) !== "dokumentnummer") {
    throw new RisValidationError("State-law names and numeric Gesetzesnummer values do not identify a unique Austrian state. Search ris_search(corpus='state_law', title=…, bundesland=…, in_force_on=…) and use that section's ris_citation.id with applikation='LrKons' and section_ref='' when reading it.");
  }
}

export function stateSearchFlag(bundesland: string): string {
  const state = BundeslandEnum.safeParse(bundesland.replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("Ä", "Ae").replaceAll("Ö", "Oe").replaceAll("Ü", "Ue"));
  if (!state.success) throw new RisValidationError("RIS returned an unknown Bundesland. Refusing an unscoped state-law structure lookup.");
  return `Bundesland.SucheIn${state.data}`;
}
