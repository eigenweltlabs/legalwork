import { Blocks, Bot, ChevronRight, Plug, Terminal } from "lucide-react";
import type { SkillCard } from "@/app/types";
import type { ImportedPlugin, ImportedPluginFile } from "@/app/lib/extension-imports";
import { t } from "@/i18n";
import { pluginImportConnectorName, pluginImportSkillName } from "./plugin-import-presentation";
import { ConnectorStatus } from "./connector-status";
import { useIntegrationLibraryLayout } from "./integration-library";

const sections = [
  { type: "skill", label: "skills.package_skills", Icon: Blocks },
  { type: "mcp", label: "skills.package_connectors", Icon: Plug },
  { type: "command", label: "skills.package_commands", Icon: Terminal },
  { type: "agent", label: "skills.package_agents", Icon: Bot },
];

export function packageParts(types: readonly string[], skillsAsWorkflows = false): string {
  return sections.map(({ type, label }) => ({ label: skillsAsWorkflows && type === "skill" ? "skills.package_workflows" : label, count: types.filter(each => each === type).length })).filter(({ count }) => count > 0).map(({ label, count }) => t(label, { count })).join(" · ");
}

/** Display labels never substitute for the installed identity used to open/edit. */
export function pluginFileInstalledName(file: ImportedPluginFile): string {
  if (file.objectType === "mcp") return file.path.startsWith("opencode.jsonc#mcp.") ? file.path.slice("opencode.jsonc#mcp.".length) : file.title;
  const path = file.path.replace(/\\/g, "/");
  return file.objectType === "skill" ? path.match(/\/([^/]+)\/SKILL\.md$/i)?.[1] ?? file.title : path.split("/").at(-1)?.replace(/\.md$/i, "") ?? file.title;
}

export function pluginComponentLabel(file: ImportedPluginFile): string {
  return file.objectType === "mcp" ? pluginImportConnectorName(pluginFileInstalledName(file)) : pluginImportSkillName({ name: file.title, path: file.path });
}

export function ImportedPackageContents(props: { plugin: ImportedPlugin; skills?: readonly SkillCard[]; query?: string; onOpen?: (file: ImportedPluginFile) => void; busy?: boolean }) {
  const connectorState = useIntegrationLibraryLayout()?.connectorState;
  const query = (props.query ?? "").trim().toLowerCase();
  const groups = sections.map(section => ({ ...section, items: props.plugin.files.filter(file => file.objectType === section.type).map(file => ({ file, name: pluginComponentLabel(file), description: file.objectType === "skill" ? props.skills?.find(skill => skill.name === pluginFileInstalledName(file))?.description ?? "" : "", state: file.objectType === "mcp" ? connectorState?.(pluginFileInstalledName(file)) : undefined })) }));
  const excluded = props.plugin.excludedConnectors?.filter(item => `${item.name} ${item.message}`.toLowerCase().includes(query)) ?? [];
  if (!groups.some(group => group.items.length) && !excluded.length) return <p className="text-sm text-muted-foreground">{t("extensions.import_no_components")}</p>;
  const visible = groups.map(group => ({ ...group, matches: group.items.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query)) }));
  if (!visible.some(group => group.matches.length) && !excluded.length) return <p role="status" className="py-6 text-center text-sm text-muted-foreground">{t("plugin_details.no_matches")}</p>;
  return <div className="space-y-5">{visible.map(({ type, label, Icon, matches }) => matches.length ? <section key={type} className="space-y-1">
    <h3 className="px-3 pb-1 text-xs font-medium text-muted-foreground">{t(label, { count: matches.length })}</h3>
    <ul>{matches.map(({ file, name, description, state }) => <li key={file.path}>
      {props.onOpen ? <button type="button" disabled={props.busy} onClick={() => props.onOpen?.(file)} aria-label={t("plugin_details.open_component", { name })} className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border"><Icon className="size-4 text-muted-foreground" /></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{name}</span>{description ? <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{description}</span> : null}</span>
        {state !== undefined ? <ConnectorStatus state={state} /> : null}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
      </button> : <div className="flex items-center gap-2 px-3 py-2 text-sm"><Icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words">{name}</span>{state !== undefined ? <ConnectorStatus state={state} /> : null}</div>}
    </li>)}</ul>
  </section> : null)}{excluded.length ? <section className="space-y-2 px-3"><h3 className="text-xs font-medium text-muted-foreground">{t("extensions.import_excluded_connectors")}</h3>{excluded.map(item => <div key={item.name} className="rounded-lg border border-border p-3"><p className="text-sm font-medium">{item.name}</p><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.message}</p></div>)}</section> : null}</div>;
}
