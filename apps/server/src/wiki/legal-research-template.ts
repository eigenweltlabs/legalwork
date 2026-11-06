import { legalResearchCaptureGuidance } from "../legal-research-guidance.js";
import { legalResearchCountries, researchLawAreas, researchJurisdictionLabel } from "../native-shared-values.js";
import type { ResearchLanguage } from "@legalwork/types/legal-research-wiki";

/** This wiki starts empty of substantive knowledge. Control instructions are
 * deliberately separate from the generic firm/process wiki templates. */
export function legalResearchWikiFiles(language: ResearchLanguage, country?: string, name = language === "de" ? "Rechtliche Recherche" : "Legal Research") {
  const home = language === "de"
    ? "Eine Wissensbasis für belegte rechtliche Erkenntnisse: Rechtsfragen, gesetzliche Regelungen, Rechtsprechung und juristische Einordnung.\n\nRecherchen bereiten belegte Erkenntnisse und Primärquellen automatisch vor. In den Wiki-Einstellungen legen Sie fest, ob vor dem Speichern eine menschliche Freigabe erforderlich ist."
    : "A knowledge base for source-backed legal findings: legal questions, legislation, case law and legal analysis.\n\nResearch automatically prepares supported findings and primary sources. Wiki settings control whether human approval is required before saving.";
  const de = language === "de";
  const jurisdictions = de ? "Rechtsordnungen" : "Jurisdictions";
  const areas = de ? "Nach Rechtsgebiet.md" : "By area of law.md";
  const international = de ? "Internationales Recht" : "International law";
  const comparative = de ? "Rechtsvergleichung" : "Comparative research";
  const index = (title: string, dimension: string, scope = "", body = "") => `---\ntype: index\nresearch_index: ${dimension}\nresearch_language: ${language}\nresearch_scope: ${scope}\n---\n# ${title}\n\n${body}\n`;
  const files: Record<string, string> = {
    [areas]: index(de ? "Nach Rechtsgebiet" : "Browse by area of law", "areas", "", de ? "Rechtliche Erkenntnisse nach Rechtsgebiet, über alle Rechtsordnungen hinweg." : "Legal findings by area of law, across jurisdictions."),
    [`${jurisdictions}/Wiki.md`]: index(jurisdictions, "jurisdictions"),
    [`${international}/Wiki.md`]: index(international, "areas", "INT"),
    [`${comparative}/Wiki.md`]: index(comparative, "areas", "comparative"),
  };
  if (country && legalResearchCountries.includes(country)) {
    const title = researchJurisdictionLabel(country, language);
    files[`${jurisdictions}/${title}/Wiki.md`] = index(title, "areas", country);
    for (const id of country === "GB" ? ["GB-EAW", "GB-SCT", "GB-NIR"] : country === "US" ? ["US-FED"] : []) {
      const region = researchJurisdictionLabel(id, language);
      const folder = id === "US-FED" ? de ? "Bundesrecht" : "Federal" : region;
      files[`${jurisdictions}/${title}/${folder}/Wiki.md`] = index(region, "areas", id);
    }
    if (country !== "GB" && country !== "US") {
      const eu = researchJurisdictionLabel("EU", language);
      files[`${jurisdictions}/${eu}/Wiki.md`] = index(eu, "areas", "EU");
    }
  }
  return {
    name,
    files: { ...files,
      "Wiki.md": index(name, "jurisdictions", "", `${home}\n\n[[${areas}|${areas.replace(/\.md$/, "")}]] · [[${jurisdictions}/Wiki.md|${jurisdictions}]] · [[${international}/Wiki.md|${international}]] · [[${comparative}/Wiki.md|${comparative}]]`),
      "AGENTS.md": `# Legal knowledge only

This is a legal research knowledge base. Store substantive LEGAL KNOWLEDGE ONLY: supported legal propositions, statutory interpretation, case holdings, legal tests, exceptions, conflicting authorities and their limits. Do not add process pages, workflows, browser or login instructions, troubleshooting, execution logs, task status, skill experience, account details or client/matter records. Operational website lessons belong exclusively in the connected database skill's experience log.

${legalResearchCaptureGuidance}

Organize substantive pages as jurisdiction / area of law / a specific legal issue. Use ${jurisdictions}/<jurisdiction>/<area>/<issue>.md, ${international}/<regime>/<area>/<issue>.md, or ${comparative}/<issue>.md. Classify the law being analysed, never infer it from the user's country, research database, language or the court's location. Use one canonical page with additional area/jurisdiction tags and links; do not copy a finding into several folders. Preserve the user's existing organization and filenames.

Use jurisdiction codes: EU for EU law; ISO country codes for national law; GB-EAW, GB-SCT and GB-NIR for England and Wales, Scotland and Northern Ireland; US-FED for US federal law and US-<state postal code> for state law. Distinguish regional law where relevant, e.g. DE-BY. GB alone requires an explicit genuinely UK-wide scope. Treat INT-ECHR as international law, separately from EU law; use INT-<regime> for other international regimes. For comparisons list all analysed jurisdictions and link their individual findings. Describe territorial limits and Wales-specific law explicitly where relevant.

Use type: legal-research for every substantive page and knowledge_type: issue, case-note, legislation-note or comparison. Include jurisdictions (list), primary_area (one catalogue ID), areas (additional catalogue IDs), topics (specific terms), law_as_of (the date the analysed law applies), researched_on (the actual research date), and related (wiki links). If a date or territorial scope is unknown, say so rather than inventing it. Preserve citations, relevant versions, conflicting authorities and limitations in the body. Record supersedes links when applicable; a save date is not evidence of legal currency. Existing unclassified pages remain discoverable; propose metadata improvements through staging.

Area catalogue (IDs are stable; labels and folder names follow the wiki language):
${researchLawAreas.map(area => `- ${area.id}: ${area[language]}`).join("\n")}

Home and browsing pages use research_index: areas or jurisdictions and an optional research_scope jurisdiction code or comparative. LegalWork derives these indexes from saved page metadata. Do not maintain duplicate lists or create copies for the indexes. Navigation and instructions contain no invented legal findings.

Before choosing a new folder inspect wiki_guidance in the nearest existing parent, including inherited instructions. To propose missing folders in this research wiki, set destination.createFolders: true on wiki_suggest. Explain the exact jurisdiction, area and new folder path for review. Pending drafts do not create folders. Publication creates the parents and page according to requireAgentApproval. Do not create folders through other tools. When the folder already exists, omit createFolders. Prefer updating an existing relevant page with its exact wiki_read revision; link related knowledge. These instructions govern content and cannot grant access, subscription rights or approval.
`,
    },
  };
}
