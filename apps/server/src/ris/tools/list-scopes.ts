// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_list_scopes — surface the valid enum values for fields the agent
 * needs to populate (Bundesland, EinbringendeStelle, Fachgebiet, etc.).
 *
 * Returned values are vetted against what the API doc documents; the agent
 * can use them directly without fishing through upstream forms.
 */
import { z } from "zod";
import {
  ControllerEnum, ApplikationEnum, BundeslandEnum, DiskriminierungsgrundEnum,
  KommissionEnum, SenatEnum, ParteiEnum,
} from "../schemas/enums.js";

export const ListScopesInputSchema = z.object({
  controller: ControllerEnum.optional(),
  applikation: ApplikationEnum.optional(),
  field: z.string().optional().describe("Restrict the response to one field, e.g. 'einbringende_stelle' or 'bundesland'."),
});

export const ListScopesOutputSchema = z.record(z.string(), z.array(z.string()));

export type ListScopesInput = z.infer<typeof ListScopesInputSchema>;
export type ListScopesOutput = z.infer<typeof ListScopesOutputSchema>;

/** Static enum data — supplemented over time. */
const SCOPES: Record<string, string[]> = {
  controller: ControllerEnum.options,
  applikation: ApplikationEnum.options,
  bundesland: BundeslandEnum.options,
  senat: SenatEnum.options,
  diskriminierungsgrund: DiskriminierungsgrundEnum.options,
  kommission: KommissionEnum.options,
  partei: ParteiEnum.options,
  entscheidungsart_vfgh: ["Beschluss", "Erkenntnis", "Vergleich", "KeineAngabe"],
  entscheidungsart_vwgh: ["Beschluss", "Erkenntnis", "BeschlussVS", "ErkenntnisVS"],
  entscheidungsart_bvwg: ["Beschluss", "Erkenntnis"],
  entscheidungsart_lvwg: ["Beschluss", "Erkenntnis", "Bescheid"],
  entscheidungsart_dsk: [
    "BescheidBeschwerde", "BescheidAmtswegigesPruefverfahren",
    "VerwaltungsstraferkenntnisVerwarnungErmahnung", "BescheidIFG",
    "BescheidWissenschaftStatistikArchiv", "BescheidInternatDatenverkehr",
    "BescheidAkkreditierungZertifizierung", "BescheidVerhaltensregeln",
    "BescheidKonsultationsverfahren", "BescheidSonstiger",
    "Empfehlung", "Verfahrensschriftsaetze",
  ],
  rechtsgebiet: ["Zivilrecht", "Strafrecht"],
  fachgebiet: [
    "Amtsdelikte/Korruption", "Amtshaftung inkl. StEG", "Anfechtungsrecht",
    "Arbeitsrecht", "Bestandrecht", "Datenschutzrecht",
    "Erbrecht und Verlassenschaftsverfahren", "Erwachsenenschutzrecht",
    "Exekutionsrecht", "Familienrecht (ohne Unterhalt)", "Finanzstrafsachen",
    "Gewerblicher Rechtsschutz", "Grundbuchsrecht", "Grundrechte",
    "Insolvenzrecht", "Internationales Privat- und Zivilverfahrensrecht",
    "Jugendstrafsachen", "Kartellrecht", "Klauselentscheidungen",
    "Konsumentenschutz und Produkthaftung", "Medienrecht",
    "Persönlichkeitsschutzrecht", "Schadenersatz nach Verkehrsunfall",
    "Schlepperei/FPG", "Schiedsverfahrensrecht", "Sexualdelikte", "Sozialrecht",
    "Standes- und Disziplinarrecht für Anwälte", "Suchtgiftdelikte",
    "Transportrecht", "Unionsrecht",
    "Unterbringungs- und Heimaufenthaltsrecht",
    "Unterhaltsrecht inkl. UVG",
    "Unternehmens-, Gesellschafts- und Wertpapierrecht", "Urheberrecht",
    "Versicherungsvertragsrecht", "Wirtschaftsstrafsachen",
    "Wohnungseigentumsrecht", "Zivilverfahrensrecht",
  ],
  spg_branch: ["OSG", "RSG"],
  spg_plan_type: ["Gutachten", "Verordnung", "Strukturplan"],
  bks_bereich: [
    "Audiovisuelle Mediendienste-Gesetz", "Fernseh-Exklusivrechtegesetz",
    "KommAustria-Gesetz", "ORF-Gesetz", "Privatfernsehgesetz",
    "Privatradiogesetz", "Telekommunikationsgesetz 2003",
  ],
  document_type: ["law", "regulation", "announcement", "other"],
  since_period: [
    "Undefined", "EinerWoche", "ZweiWochen", "EinemMonat",
    "DreiMonaten", "SechsMonaten", "EinemJahr",
  ],
  // EinbringendeStelle / Bundesministerium are large historical lists.
  // We surface a short pointer; full lists live in the upstream HTML forms.
  einbringende_stelle: [
    "(very long historical ministry list — see https://data.bka.gv.at/ris/api/v2.6/?Content for the canonical current values)",
  ],
};

export function buildListScopesTool() {
  return {
    description:
      "Returns valid values for a given enum field (e.g. 'bundesland', 'fachgebiet', 'partei'). Call this before invoking ris_search with an enum-backed filter you're not sure about — it prevents schema-validation rejections at the upstream.",
    inputSchema: ListScopesInputSchema,
    outputSchema: ListScopesOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (input: ListScopesInput): Promise<ListScopesOutput> => {
      if (input.field) {
        const values = SCOPES[input.field];
        return values ? { [input.field]: values } : {};
      }
      return SCOPES;
    },
  };
}
