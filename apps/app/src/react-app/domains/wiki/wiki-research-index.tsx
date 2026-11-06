import { useState } from "react";
import type { WikiPage } from "@legalwork/types/wiki";
import { researchIndexGroups, researchJurisdictionLabel, researchLawAreas } from "@legalwork/types/legal-research-wiki";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { wikiPropertyFields } from "./wiki-properties";

/** A navigation projection over saved pages, never a second copy of their findings. */
export function WikiResearchIndex({ content, pages, onOpen }: { content: string; pages: WikiPage[]; onOpen: (path: string) => void }) {
  const locale = useLocale() === "de" ? "de" : "en";
  const [selected, setSelected] = useState("");
  const { fields, error } = wikiPropertyFields(content);
  const dimension = fields.find(field => field.key === "research_index")?.value;
  const scope = fields.find(field => field.key === "research_scope")?.value;
  if (error || dimension !== "areas" && dimension !== "jurisdictions") return null;
  const groups = researchIndexGroups(pages, dimension, typeof scope === "string" ? scope : "");
  const landings = pages.filter(page => page.type === "index" && typeof page.properties.research_scope === "string" && page.properties.research_scope && page.properties.research_scope !== "comparative");
  const label = (id: string) => id === "unclassified" ? t("research.unclassified") : dimension === "areas" ? researchLawAreas.find(area => area.id === id)?.[locale] ?? id : researchJurisdictionLabel(id, locale);
  const ids = [...new Set([...groups.keys(), ...(dimension === "areas" ? researchLawAreas.map(area => area.id) : landings.map(page => String(page.properties.research_scope)))])].sort((a, b) => label(a).localeCompare(label(b), locale));
  const visible = [...groups.entries()].filter(([id]) => !selected || selected === id).sort(([a], [b]) => label(a).localeCompare(label(b), locale));
  const options = [{ value: "", label: t("research.all_findings") }, ...ids.map(id => ({ value: id, label: label(id) }))];
  return <section className="mx-auto mt-6 max-w-[720px] space-y-5 border-t pt-5" aria-label={t("research.saved_findings")}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-medium">{t("research.saved_findings")}</h2><Select value={selected} items={options} onValueChange={id => setSelected(id ?? "")}><SelectTrigger aria-label={dimension === "areas" ? t("research.area_filter") : t("research.jurisdiction_filter")} className="w-full sm:w-80"><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
    {dimension === "jurisdictions" && <div className="flex flex-wrap gap-2">{landings.map(page => <button key={page.path} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => onOpen(page.path)}>{page.title}</button>)}</div>}
    {!visible.length && <p className="text-sm text-muted-foreground">{t("research.no_saved_findings")}</p>}
    {visible.map(([id, items]) => <div key={id}><h3 className="mb-2 text-sm font-medium">{label(id)} <span className="text-muted-foreground">({items.length})</span></h3><ul className="space-y-1">{[...items].sort((a, b) => a.title.localeCompare(b.title, locale)).map(page => <li key={page.path}><button className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => onOpen(page.path)}>{page.title}</button></li>)}</ul></div>)}
  </section>;
}

export function ResearchClassification({ content }: { content: string }) {
  const locale = useLocale() === "de" ? "de" : "en";
  const { fields } = wikiPropertyFields(content);
  const values = (key: string) => {
    const value = fields.find(field => field.key === key)?.value;
    return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  };
  if (!values("type").includes("legal-research")) return null;
  const jurisdictions = [...new Set([...values("jurisdictions"), ...values("jurisdiction")])];
  const areas = [...new Set([...values("primary_area"), ...values("areas")])];
  return <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
    <div><dt className="inline font-medium">{t("research.jurisdiction_filter")}: </dt><dd className="inline">{jurisdictions.map(id => researchJurisdictionLabel(id, locale)).join(", ") || t("research.unclassified")}</dd></div>
    <div><dt className="inline font-medium">{t("research.area_filter")}: </dt><dd className="inline">{areas.map(id => researchLawAreas.find(area => area.id === id)?.[locale] ?? id).join(", ") || t("research.unclassified")}</dd></div>
    <div><dt className="inline font-medium">{t("research.law_as_of")}: </dt><dd className="inline">{values("law_as_of").join(", ") || t("research.not_recorded")}</dd><dt className="ml-3 inline font-medium">{t("research.researched_on")}: </dt><dd className="inline">{values("researched_on").join(", ") || t("research.not_recorded")}</dd></div>
  </dl>;
}
