import { useId } from "react";
import { AssistantProjectAccessSchema, type AssistantSettings, type AssistantSettingsCatalog, type AssistantResource } from "@legalwork/types/main-assistant";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Surface } from "@/react-app/design-system/surface";
import { t } from "@/i18n";
import { AssistantResourcePicker } from "./assistant-resource-picker";
import { AssistantProjectPicker } from "./assistant-project-picker";
import { LayoutSection, LayoutSectionHeader, LayoutSectionTitle, LayoutSectionDescription } from "../settings-layout";
import { SettingsNotice } from "../settings-section";

const accessModes: Array<{ value: AssistantSettings["projectAccess"]["mode"]; label: "assistant.access_all" | "assistant.access_none" | "assistant.access_exclude" | "assistant.access_include" }> = [
  { value: "all", label: "assistant.access_all" }, { value: "include", label: "assistant.access_include" },
  { value: "exclude", label: "assistant.access_exclude" }, { value: "none", label: "assistant.access_none" },
];
const resourceKinds: Array<{ kind: AssistantResource["kind"]; label: "extensions.filter_plugins" | "sidebar.workflows" | "dashboard.skills" }> = [
  { kind: "plugin", label: "extensions.filter_plugins" }, { kind: "workflow", label: "sidebar.workflows" }, { kind: "skill", label: "dashboard.skills" },
];
function toggle(items: string[], id: string, checked: boolean) {
  return checked ? [...new Set([...items, id])] : items.filter(item => item !== id);
}

export function AssistantBehaviorFields({ settings: draft, catalog, disabled, onChange: setDraft, onInstructionsBlur }: {
  settings: AssistantSettings; catalog: AssistantSettingsCatalog; disabled?: boolean; onChange: (settings: AssistantSettings) => void; onInstructionsBlur?: () => void;
}) {
  const id = useId();
  const missing = draft.resourceIds.filter(ref => !catalog.resources.some(item => item.id === ref));
  return <fieldset disabled={disabled} className="min-w-0 space-y-8">
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle><label htmlFor={`${id}-prompt`}>{t("assistant.instructions")}</label></LayoutSectionTitle>
        <LayoutSectionDescription><span id={`${id}-prompt-help`}>{t("assistant.instructions_hint")}</span></LayoutSectionDescription>
      </LayoutSectionHeader>
      <Textarea id={`${id}-prompt`} aria-describedby={`${id}-prompt-help`} value={draft.systemPromptAddition} rows={5} className="min-h-36 resize-y rounded-2xl bg-background px-4 py-3 text-sm leading-relaxed" placeholder={t("assistant.instructions_placeholder")} onChange={event => setDraft({ ...draft, systemPromptAddition: event.target.value })} onBlur={onInstructionsBlur} />
    </LayoutSection>
    <LayoutSection>
      <LayoutSectionHeader><LayoutSectionTitle>{t("assistant.resources")}</LayoutSectionTitle><LayoutSectionDescription>{t("assistant.resources_hint")}</LayoutSectionDescription></LayoutSectionHeader>
      {catalog.unavailable.length > 0 && <SettingsNotice><span role="status">{t("assistant.resources_partial")}</span></SettingsNotice>}
      <Surface className="divide-y divide-border/70">
        {resourceKinds.map(({ kind, label }) => <AssistantResourcePicker key={kind} kind={kind} label={t(label)} resources={catalog.resources.filter(item => item.kind === kind)}
          selectedIds={draft.resourceIds} disabled={disabled}
          projectAllowed={projectId => !catalog.projects.some(project => project.id === projectId) || projectAllowed(draft, projectId)}
          onToggle={(resourceId, checked) => setDraft({ ...draft, resourceIds: toggle(draft.resourceIds, resourceId, checked) })} />)}
        {missing.map(ref => <label key={ref} className="flex cursor-pointer items-center gap-3 px-5 py-4 text-sm text-muted-foreground"><Checkbox checked onCheckedChange={() => setDraft({ ...draft, resourceIds: draft.resourceIds.filter(item => item !== ref) })} />{t("assistant.resource_unavailable")}</label>)}
      </Surface>
    </LayoutSection>
    <LayoutSection>
      <LayoutSectionHeader><LayoutSectionTitle><span id={`${id}-access-label`}>{t("assistant.project_access")}</span></LayoutSectionTitle><LayoutSectionDescription><span id={`${id}-access-help`}>{t("assistant.project_access_hint")}</span></LayoutSectionDescription></LayoutSectionHeader>
      <RadioGroup aria-labelledby={`${id}-access-label`} aria-describedby={`${id}-access-help`} disabled={disabled} value={draft.projectAccess.mode} className="grid-cols-1 gap-2 @min-[560px]/settings:grid-cols-2" onValueChange={value => {
        const parsed = AssistantProjectAccessSchema.shape.mode.safeParse(value);
        if (parsed.success) setDraft({ ...draft, projectAccess: { ...draft.projectAccess, mode: parsed.data } });
      }}>{accessModes.map(mode => <label key={mode.value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm transition-colors hover:bg-muted/40 has-[[aria-checked=true]]:border-foreground/35 has-[[aria-checked=true]]:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40"><RadioGroupItem value={mode.value} />{t(mode.label)}</label>)}</RadioGroup>
      {(draft.projectAccess.mode === "include" || draft.projectAccess.mode === "exclude") && <AssistantProjectPicker
        projects={catalog.projects} selectedIds={draft.projectAccess.projectIds} mode={draft.projectAccess.mode} disabled={disabled}
        onToggle={(projectId, checked) => setDraft({ ...draft, projectAccess: { ...draft.projectAccess, projectIds: toggle(draft.projectAccess.projectIds, projectId, checked) } })}
      />}
    </LayoutSection>
  </fieldset>;
}
function projectAllowed(settings: AssistantSettings, id: string) {
  const access = settings.projectAccess;
  return access.mode === "all" || access.mode === "include" && access.projectIds.includes(id) || access.mode === "exclude" && !access.projectIds.includes(id);
}
