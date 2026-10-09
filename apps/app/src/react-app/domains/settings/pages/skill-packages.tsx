/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Blocks, Package, Trash2 } from "lucide-react";

import { t } from "@/i18n";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import type { ImportedPlugin } from "../../../../app/lib/extension-imports";
import { BUILT_IN_SKILLS } from "../built-in-skills";

/**
 * Two parts of the Skills tab: the packages imported into this workspace (a
 * package brings skills, connectors and commands at once; each part also shows
 * in its own list) and the skills built into LegalWork.
 */

export type SkillPackagesStore = {
  importedPackages: () => Promise<ImportedPlugin[]>;
  removeImportedPackage: (pluginId: string) => Promise<void>;
};

const cardClass = "rounded-[16px] border border-dls-border bg-dls-surface p-3.5";
const iconClass = "inline-flex size-7 shrink-0 items-center justify-center rounded-[9px] border border-dls-border bg-dls-hover text-dls-accent";

const PART_COPY = {
  skill: "skills.package_skills",
  mcp: "skills.package_connectors",
  command: "skills.package_commands",
  agent: "skills.package_agents",
} as const;

/** What a package brings, from the type of each of its parts, in words: "2 skills · 1 connector". */
export function packageParts(types: readonly string[]): string {
  return (["skill", "mcp", "command", "agent"] as const)
    .map((type) => ({ type, count: types.filter((each) => each === type).length }))
    .filter(({ count }) => count > 0)
    .map(({ type, count }) => t(PART_COPY[type], { count }))
    .join(" · ");
}

export function ImportedPackages(props: {
  extensions: SkillPackagesStore;
  busy: boolean;
  /** Changes when a package was imported, so the list is read again. */
  revision: number;
}) {
  const { extensions } = props;
  const [packages, setPackages] = useState<ImportedPlugin[]>([]);
  const [removing, setRemoving] = useState<ImportedPlugin | null>(null);

  useEffect(() => {
    let stopped = false;
    extensions.importedPackages()
      .then((list) => {
        if (!stopped) setPackages(list);
      })
      .catch(() => {
        // The server is not reachable: nothing to show until it is.
      });
    return () => {
      stopped = true;
    };
  }, [extensions, props.revision]);

  async function remove(plugin: ImportedPlugin) {
    try {
      await extensions.removeImportedPackage(plugin.pluginId);
      setPackages((list) => list.filter((each) => each.pluginId !== plugin.pluginId));
      toast.success(t("skills.package_removed", { name: plugin.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("skills.unknown_error"));
    }
  }

  if (packages.length === 0) return null;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="lw-section-eyebrow uppercase text-dls-secondary">{t("skills.packages_title")}</span>
        <span className="font-mono text-[11px] tabular-nums text-dls-secondary">{packages.length.toString().padStart(2, "0")}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {packages.map((plugin) => (
          <div key={plugin.pluginId} className={`${cardClass} group`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className={iconClass}>
                  <Package size={14} strokeWidth={1.75} />
                </span>
                <h4 className="truncate text-[14px] font-medium tracking-[-0.01em] text-dls-text">{plugin.name}</h4>
                {plugin.scope === "global" ? <span className="text-xs text-dls-secondary">{t("extensions.import_all_projects")}</span> : null}
              </div>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-40"
                disabled={props.busy}
                onClick={() => setRemoving(plugin)}
                title={t("skills.package_remove")}
                aria-label={t("skills.package_remove_named", { name: plugin.name })}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {plugin.description ? <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">{plugin.description}</p> : null}
            <p className="mt-2 text-[12px] text-dls-secondary">{packageParts(plugin.files.map((file) => file.objectType))}</p>
          </div>
        ))}
      </div>
      <ConfirmModal
        open={removing !== null}
        title={t("skills.package_remove_title", { name: removing?.name ?? "" })}
        message={t(removing?.scope === "global" ? "extensions.import_remove_global" : "skills.package_remove_message")}
        confirmLabel={t("skills.package_remove")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) void remove(target);
        }}
      />
    </div>
  );
}

export function BuiltInSkills() {
  return (
    <div className="space-y-4">
      <span className="lw-section-eyebrow uppercase text-dls-secondary">{t("skills.built_in_title")}</span>
      <div className="grid gap-3 sm:grid-cols-2">
        {BUILT_IN_SKILLS.map((skill) => (
          <div key={skill.id} className={cardClass}>
            <div className="flex min-w-0 items-center gap-2">
              <span className={iconClass}>
                <Blocks size={14} strokeWidth={1.75} />
              </span>
              <h4 className="truncate text-[14px] font-medium tracking-[-0.01em] text-dls-text">{skill.name}</h4>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-dls-secondary">{skill.description()}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {skill.commands.map((command) => (
                <span key={command} className="rounded-lg bg-dls-hover px-2 py-1 font-mono text-[11px] text-dls-text">{command}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
