/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import type { SkillsExtensionsStore } from "./skills-view";

const SOURCE = "https://github.com/LegalQuants/lq-plugin-oss/tree/main/skills";
type Catalog = Awaited<ReturnType<SkillsExtensionsStore["scanGithubSkills"]>>;
type Props = {
  busy: boolean;
  existingNames: Set<string>;
  extensions: Pick<SkillsExtensionsStore, "scanGithubSkills" | "importGithubSkills">;
  className: string;
};

export function LegalQuantsImportButton(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={props.className} disabled={props.busy} onClick={() => setOpen(true)}>
      <Download size={14} /> LegalQuants
    </button>
    {open ? <LegalQuantsImportModal {...props} onClose={() => setOpen(false)} /> : null}
  </>;
}

function LegalQuantsImportModal({ extensions, existingNames, onClose }: Props & { onClose: () => void }) {
  const categories = [
    { key: "litigation", label: t("skills.legalquants_litigation") },
    { key: "transactional", label: t("skills.legalquants_transactional") },
    { key: "core", label: t("skills.legalquants_core") },
    { key: "companion", label: t("skills.legalquants_companion") },
  ];
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("litigation");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    setCatalog(null);
    void extensions.scanGithubSkills(SOURCE).then((result) => {
      if (active) setCatalog(result);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : t("skills.repo_scan_failed"));
    });
    return () => { active = false; };
  }, [extensions.scanGithubSkills, attempt]);

  const isInstalled = (dir: string) => existingNames.has(`workflow-assistant-${dir.split("/").pop()}`);
  const matches = (name: string, description: string) => `${name} ${description}`.toLowerCase().includes(query.trim().toLowerCase());
  const items = catalog?.skills.filter((skill) => skill.dir.startsWith(`skills/${category}/`) && matches(skill.name, skill.description)) ?? [];
  const available = items.filter((skill) => !isInstalled(skill.dir));
  const allSelected = available.length > 0 && available.every((skill) => selected.has(skill.dir));
  const toggle = (dir: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(dir)) next.delete(dir); else next.add(dir);
    return next;
  });

  const runImport = async () => {
    if (!catalog || importing || selected.size === 0) return;
    setImporting(true);
    setStatus(null);
    setError(null);
    try {
      const result = await extensions.importGithubSkills({ url: SOURCE, ref: catalog.ref, paths: [...selected], asWorkflow: true });
      if (result.ok) {
        setStatus(result.message);
        setSelected(new Set());
      } else setError(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("skills.unknown_error"));
    } finally { setImporting(false); }
  };

  return <Dialog open onOpenChange={(next) => { if (!next && !importing) onClose(); }}>
    <DialogContent className="flex h-[min(680px,88vh)] min-h-0 flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t("skills.legalquants_title")}</DialogTitle>
        <DialogDescription>{t("skills.legalquants_hint")}</DialogDescription>
        <div className="flex gap-3 pt-1 text-xs text-dls-secondary">
          <a href="https://github.com/LegalQuants/lq-plugin-oss" target="_blank" rel="noreferrer" className="underline underline-offset-2">{t("skills.legalquants_by")}</a>
          <a href="https://github.com/LegalQuants/lq-plugin-oss/blob/main/LICENSE" target="_blank" rel="noreferrer" className="underline underline-offset-2">Apache-2.0</a>
        </div>
      </DialogHeader>
      {error ? <div role="alert" className="rounded-xl border border-red-7/20 bg-red-1/40 p-3 text-xs text-red-12">
        {error}
        {!catalog ? <Button variant="outline" className="ml-3" onClick={() => setAttempt((value) => value + 1)}>{t("skills.legalquants_retry")}</Button> : null}
      </div> : null}
      {!catalog && !error ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-dls-secondary"><Loader2 size={18} className="animate-spin" />{t("skills.legalquants_loading")}</div> : null}
      {catalog ? <>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-3 text-dls-secondary" />
          <input aria-label={t("skills.legalquants_search")} placeholder={t("skills.legalquants_search")} value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="w-full rounded-xl border border-dls-border bg-dls-hover py-2 pl-9 pr-3 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map(({ key, label }) => <button key={key} type="button" aria-pressed={category === key} onClick={() => setCategory(key)} className={`rounded-full px-3 py-1.5 text-xs transition-colors ${category === key ? "bg-dls-text text-dls-surface" : "bg-dls-hover text-dls-secondary hover:text-dls-text"}`}>
            {label} <span className="ml-1 opacity-60">{catalog.skills.filter((skill) => skill.dir.startsWith(`skills/${key}/`) && matches(skill.name, skill.description)).length}</span>
          </button>)}
        </div>
        <div className="flex items-center justify-between text-xs text-dls-secondary">
          <span>{t("skills.legalquants_available", { count: items.length })}</span>
          <button type="button" disabled={!available.length || importing} className="underline underline-offset-2 disabled:opacity-40" onClick={() => setSelected((previous) => {
            const next = new Set(previous);
            for (const skill of available) { if (allSelected) next.delete(skill.dir); else next.add(skill.dir); }
            return next;
          })}>{allSelected ? t("skills.legalquants_clear") : t("skills.select_all")}</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-dls-border">
          {items.length === 0 ? <p className="p-6 text-center text-sm text-dls-secondary">{t("skills.legalquants_empty")}</p> : items.map((skill) => {
            const installed = isInstalled(skill.dir);
            return <label key={skill.dir} className={`flex items-start gap-3 border-b border-dls-border p-4 last:border-0 ${installed ? "opacity-60" : "cursor-pointer hover:bg-dls-hover/60"}`}>
              <input type="checkbox" checked={installed || selected.has(skill.dir)} disabled={installed || importing} onChange={() => toggle(skill.dir)} className="mt-1 size-4 shrink-0 accent-[var(--dls-accent)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium capitalize text-dls-text">{skill.name.replace(/-/g, " ")}</span>
                  {installed ? <span className="text-xs text-dls-secondary">{t("skills.installed_status")}</span> : null}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-dls-secondary">{skill.description}</p>
              </div>
            </label>;
          })}
        </div>
      </> : null}
      <DialogFooter className="mt-auto shrink-0 items-center border-t border-dls-border pt-4">
        <div role="status" className="flex flex-1 items-center gap-2 text-xs text-dls-secondary">
          {status ? <><CheckCircle2 size={16} />{status}</> : t("skills.legalquants_selected", { count: selected.size })}
        </div>
        <Button variant="outline" disabled={importing} onClick={onClose}>{status ? t("skills.legalquants_view") : t("common.close")}</Button>
        <Button disabled={!selected.size || importing} onClick={() => void runImport()}>
          {importing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {importing ? t("skills.legalquants_importing") : t("skills.import_n_selected", { count: selected.size })}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
