// Adapted from mburgler/ris-mcp-worker, commit a99b4fe7d283dc896ecb68e76e1b81c1985a02af. Apache-2.0; see NOTICE.
/**
 * ris_citation schemas. Lean by default; full form gated by include_full_metadata.
 */
import { z } from "zod";
import { ApplikationEnum } from "./enums.js";

export const RisCitationLeanSchema = z.object({
  id: z.string().describe("RIS internal document ID, e.g. NOR40191806"),
  citation_label: z
    .string()
    .describe('Single human-readable label, e.g. "Wasserrechtsgesetz 1959 (BGBl. Nr. 215/1959 § 0)" or "VwGH 16.12.2025, Ra 2024/07/0205"'),
  applikation: ApplikationEnum,
  is_authentic: z
    .boolean()
    .describe("True only for legally binding apps (BgblAuth, LgblAuth, Vbl, Bvb, GrA, PruefGewO, Avsv, Spg, Avn, KmGer)."),
  dokument_url: z.string().url().describe("Canonical RIS metadata page."),
  retrieved_at: z.string().describe("ISO-8601 UTC timestamp of retrieval."),
  gesetzesnummer: z
    .string()
    .optional()
    .describe("Consolidated law only: stable key of the whole law — use as id for ris_get_section/ris_verify/ris_get_document."),
  geschaeftszahl: z.string().optional().describe("Case law: case number(s), comma-joined."),
  entscheidungsdatum: z.string().optional().describe("Case law: decision date (ISO)."),
  gericht: z.string().optional().describe("Case law: deciding court."),
});

export const RisCitationFullSchema = RisCitationLeanSchema.extend({
  eli: z.string().url().optional().describe("European Legislation Identifier (consolidated law)."),
  kundmachungsorgan: z.string().optional().describe('Publication body, e.g. "BGBl. Nr. 215/1959".'),
  fassung_vom: z.string().optional().describe("Version date for consolidated text."),
  gesamte_rechtsvorschrift_url: z.string().url().optional(),
  bgblnummer: z.string().optional(),
  lgblnummer: z.string().optional(),
  kundmachungsdatum: z.string().optional(),
  teil: z.string().optional(),
  ecli: z.string().optional().describe("European Case Law Identifier."),
  sammlungsnummer: z.string().optional().describe("Collection number (VfSlg, VwSlg)."),
  rechtsgebiet: z.string().optional(),
  source: z.string().default("RIS OGD API v2.6"),
});

export type RisCitationLean = z.infer<typeof RisCitationLeanSchema>;
export type RisCitationFull = z.infer<typeof RisCitationFullSchema>;
export type RisCitation = RisCitationLean | RisCitationFull;
