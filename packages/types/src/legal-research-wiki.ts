import type { WikiPage, WikiValue } from "./wiki.js";

export type ResearchLanguage = "en" | "de";
/** Stable identifiers allow localized navigation without translating saved metadata. */
export const researchLawAreas = [
  { id: "contracts", en: "Contracts and civil liability", de: "Vertragsrecht und zivilrechtliche Haftung" },
  { id: "corporate", en: "Corporate and commercial", de: "Gesellschafts- und Handelsrecht" },
  { id: "employment", en: "Employment and social security", de: "Arbeits- und Sozialrecht" },
  { id: "competition", en: "Competition", de: "Kartell- und Wettbewerbsrecht" },
  { id: "intellectual-property", en: "Intellectual property", de: "Geistiges Eigentum" },
  { id: "privacy-technology", en: "Privacy, technology and media", de: "Datenschutz, Technologie und Medien" },
  { id: "finance", en: "Banking and financial services", de: "Bank- und Finanzmarktrecht" },
  { id: "tax", en: "Tax and customs", de: "Steuer- und Zollrecht" },
  { id: "insolvency", en: "Insolvency and restructuring", de: "Insolvenz und Restrukturierung" },
  { id: "property", en: "Property and construction", de: "Immobilien- und Baurecht" },
  { id: "public", en: "Constitutional and administrative", de: "Verfassungs- und Verwaltungsrecht" },
  { id: "regulatory", en: "Environmental and sector regulation", de: "Umweltrecht und Sektorregulierung" },
  { id: "criminal", en: "Criminal law", de: "Strafrecht" },
  { id: "family", en: "Family and succession", de: "Familien- und Erbrecht" },
  { id: "immigration", en: "Immigration and nationality", de: "Migrations- und Staatsangehörigkeitsrecht" },
  { id: "procedure", en: "Procedure and dispute resolution", de: "Verfahrensrecht und Streitbeilegung" },
  { id: "international", en: "International and conflict of laws", de: "Völkerrecht und Internationales Privatrecht" },
];
export const researchJurisdictions = [
  { id: "EU", en: "European Union", de: "Europäische Union" },
  { id: "GB-EAW", en: "England and Wales", de: "England und Wales" },
  { id: "GB-SCT", en: "Scotland", de: "Schottland" },
  { id: "GB-NIR", en: "Northern Ireland", de: "Nordirland" },
  { id: "US-FED", en: "United States · Federal", de: "USA · Bundesrecht" },
  { id: "INT", en: "International law", de: "Internationales Recht" },
  { id: "INT-ECHR", en: "European Convention on Human Rights", de: "Europäische Menschenrechtskonvention" },
];
const usStates: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
export function researchJurisdictionLabel(id: string, language: ResearchLanguage): string {
  const known = researchJurisdictions.find(item => item.id === id);
  if (known) return known[language];
  if (/^[A-Z]{2}$/.test(id)) return new Intl.DisplayNames([language], { type: "region" }).of(id) ?? id;
  if (id.startsWith("US-") && usStates[id.slice(3)]) return `${usStates[id.slice(3)]} (US)`;
  // Other regional identifiers remain explicit, e.g. DE-BY.
  return id;
}
const strings = (value: WikiValue | undefined): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export function researchPageJurisdictions(page: WikiPage) {
  return [...new Set([...strings(page.properties.jurisdictions), ...strings(page.properties.jurisdiction)])];
}
export function researchPageAreas(page: WikiPage) {
  return [...new Set([...strings(page.properties.primary_area), ...strings(page.properties.areas)])];
}
export function researchIndexGroups(pages: WikiPage[], dimension: "areas" | "jurisdictions", scope = "") {
  const groups = new Map<string, WikiPage[]>();
  for (const page of pages) {
    if (page.type !== "legal-research") continue;
    if (scope === "comparative" ? page.properties.knowledge_type !== "comparison" : scope && !researchPageJurisdictions(page).some(id => id === scope || id.startsWith(`${scope}-`))) continue;
    const values = dimension === "areas" ? researchPageAreas(page) : researchPageJurisdictions(page);
    for (const id of values.length ? values : ["unclassified"]) {
      const group = groups.get(id);
      if (group) group.push(page); else groups.set(id, [page]);
    }
  }
  return groups;
}
