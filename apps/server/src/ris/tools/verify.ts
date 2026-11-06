// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_verify — is a consolidated rule in force on a given date?
 * Returns the Inkrafttretens-/Ausserkrafttretensdatum bracket.
 *
 * A law with no version in force on the date (fully repealed, or not yet in
 * force) is reported as in_force=false with a note — not as not_found. The
 * date-filtered query is retried without the filter to make that distinction.
 */
import { z } from "zod";
import { requireStateDocumentId } from "../client/state-law.js";
import { buildGetDocumentTool, GetDocumentInputSchema } from "./get-document.js";
import type { RisClient } from "../client/ris-client.js";
import type { Applikation, RawDocRef } from "../types.js";
import { controllerForApp } from "../types.js";
import { ApplikationEnum } from "../schemas/enums.js";
import { RisCitationLeanSchema } from "../schemas/citation.js";
import { buildLeanCitation, findMetaFields } from "../client/citation.js";
import { extractDates } from "../client/normalization.js";
import { classifyId, normaliseIdInput } from "../client/content.js";
import { RisNotFoundError, RisValidationError } from "../infrastructure/errors.js";

export const VerifyInputSchema = z.object({
  id: z.string().describe("Gesetzesnummer (preferred), or a law name/abbreviation."),
  applikation: ApplikationEnum.optional().default("BrKons"),
  at_date: z.string().optional().describe("YYYY-MM-DD. Defaults to today (UTC)."),
}).strict();

export const VerifyOutputSchema = z.object({
  id: z.string(),
  in_force: z.boolean(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  at_date: z.string(),
  source: z.string(),
  note: z.string().optional().describe("Set when the law is repealed / not yet in force, with the repealing publication where RIS names it."),
  ris_citation: RisCitationLeanSchema,
});

export type VerifyInput = z.infer<typeof VerifyInputSchema>;
export type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

export function buildVerifyTool(client: RisClient) {
  return {
    description:
      "Checks consolidated law (BrKons/LrKons) validity on a date (default: today). For federal law use Gesetzesnummer or a law name/abbreviation; repealed laws return in_force=false and a repeal note. State law requires an exact document ID from a state-scoped search and checks that specific version's validity bracket; search with bundesland and in_force_on for another version. Not for gazette entries — there the gazette date is dispositive.",
    inputSchema: VerifyInputSchema,
    outputSchema: VerifyOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (input: VerifyInput): Promise<VerifyOutput> => {
      const at = input.at_date ?? new Date().toISOString().slice(0, 10);
      const app: Applikation = input.applikation ?? "BrKons";
      // Verify is a consolidated-law operation (it sends Fassung.FassungVom,
      // which non-consolidated controllers reject with a raw schema error).
      if (app !== "BrKons" && app !== "LrKons") {
        throw new RisValidationError(
          `ris_verify only supports consolidated law (applikation=BrKons or LrKons); got '${app}'. ` +
            `For gazette entries the publication date is dispositive; for case law use ris_get_section.`,
        );
      }
      const controller = controllerForApp(app);

      const id = normaliseIdInput(input.id);
      requireStateDocumentId(app, id);
      if (app === "LrKons") {
        const document = await buildGetDocumentTool(client).handler(GetDocumentInputSchema.parse({ id, applikation: app }));
        const from = document.dates.in_force_from, to = document.dates.in_force_to;
        if (!from && !to) throw new RisValidationError("RIS did not provide validity dates for this state-law document. No verified validity result is available.");
        return { id: input.id, in_force: isWithinRange(at, from, to), valid_from: from, valid_to: to, at_date: at,
          source: "RIS OGD API v2.6", note: "Validity applies to this exact document version. Search with bundesland and in_force_on to find other versions of the state provision.", ris_citation: document.ris_citation };
      }
      const baseParams = new Map<string, string>();
      baseParams.set("Applikation", app);
      if (classifyId(id) === "gesetzesnummer") {
        baseParams.set("Gesetzesnummer", id);
      } else {
        baseParams.set("Titel", id);
      }
      baseParams.set("DokumenteProSeite", "Ten");
      baseParams.set("Seitennummer", "1");

      // Pass 1: versions in force at the date.
      const dated = new Map(baseParams);
      dated.set("Fassung.FassungVom", at);
      const { records: inForceRecords } = await client.query(controller, dated);

      if (inForceRecords.length > 0) {
        const match = inForceRecords[0]!;
        const dates = extractDates(match);
        return {
          id: input.id,
          in_force: isWithinRange(at, dates.in_force_from, dates.in_force_to),
          valid_from: dates.in_force_from,
          valid_to: dates.in_force_to,
          at_date: at,
          source: `RIS ${app}`,
          ris_citation: buildLeanCitation(match),
        };
      }

      // Pass 2: nothing in force at the date — does the law exist at all?
      const { records: anyRecords } = await client.query(controller, baseParams);
      if (anyRecords.length === 0) {
        throw new RisNotFoundError(
          `No RIS record found for id='${input.id}' in applikation=${app}. ` +
            `If this id was guessed, search first: ris_search(corpus=…, title='<name or abbreviation>').`,
        );
      }

      const bracket = validityBracket(anyRecords);
      const repeal = repealNote(anyRecords);
      const note =
        repeal ??
        (bracket.from && bracket.from > at
          ? `No version in force on ${at}; the law enters into force on ${bracket.from}.`
          : `No version of this law is in force on ${at} (repealed or expired).`);

      return {
        id: input.id,
        in_force: false,
        valid_from: bracket.from,
        valid_to: bracket.to,
        at_date: at,
        source: `RIS ${app}`,
        note,
        ris_citation: buildLeanCitation(anyRecords[0]!),
      };
    },
  };
}

function isWithinRange(at: string, from: string | null, to: string | null): boolean {
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

/** Earliest in-force-from / latest in-force-to across the returned page. */
function validityBracket(records: RawDocRef[]): { from: string | null; to: string | null } {
  let from: string | null = null;
  let to: string | null = null;
  for (const rec of records) {
    const d = extractDates(rec);
    if (d.in_force_from && (!from || d.in_force_from < from)) from = d.in_force_from;
    if (d.in_force_to && (!to || d.in_force_to > to)) to = d.in_force_to;
  }
  return { from, to };
}

/** RIS marks repeals in Kundmachungsorgan: "BGBl. Nr. 287/1987 aufgehoben durch BGBl. I Nr. 5/2024". */
function repealNote(records: RawDocRef[]): string | undefined {
  for (const rec of records) {
    const organ = findMetaFields(rec, ["Kundmachungsorgan"]).Kundmachungsorgan?.[0];
    if (organ && /aufgehoben durch/i.test(organ)) {
      return `Law repealed: RIS lists it as "${organ.trim()}".`;
    }
  }
  return undefined;
}
