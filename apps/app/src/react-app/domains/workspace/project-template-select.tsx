import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { projectTemplateName, useProjectDefaultsStore } from "./project-defaults-store";

export function ProjectTemplateSelect({ value, onChange, disabled, emptyLabel, compact }: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  emptyLabel?: string;
  compact?: boolean;
}) {
  const templates = useProjectDefaultsStore((state) => state.templates);
  const selected = templates.find((template) => template.id === value);
  return <Select value={selected?.id ?? ""} onValueChange={(id) => onChange(id || null)} disabled={disabled}>
    <SelectTrigger className={compact ? "h-8 w-auto max-w-full border-0 bg-transparent px-0 text-xs text-muted-foreground shadow-none" : "w-full"} aria-label={t("projects.templates.template")} title={compact ? t("projects.templates.starting_hint") : undefined}>
      <SelectValue className="min-w-0 truncate">{compact && `${t("projects.templates.short_label")}: `}{selected ? projectTemplateName(selected) : emptyLabel ?? t("projects.templates.none")}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      {compact && <p className="max-w-72 px-2 py-2 text-xs text-muted-foreground">{t("projects.templates.starting_hint")}</p>}
      <SelectItem value="">{emptyLabel ?? t("projects.templates.none")}</SelectItem>
      {templates.map((template) => <SelectItem key={template.id} value={template.id}>{projectTemplateName(template)}</SelectItem>)}
    </SelectContent>
  </Select>;
}
