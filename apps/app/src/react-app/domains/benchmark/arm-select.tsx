/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { BenchmarkArm, BenchmarkSkillPolicy } from "../../../app/lib/benchmark-types";
import { t } from "@/i18n";

/**
 * Ablation arm editor for the start-run modal.
 *
 * An arm is a capability configuration the whole task×model grid is re-run
 * under, so the same task can be scored with and without a capability. The
 * first arm is the baseline everything else is read against — it is fixed as
 * unablated so a run always has something to compare to.
 */

export type ArmSelectProps = {
  arms: BenchmarkArm[];
  /** Tool ids the engine exposes; empty when the engine could not be asked. */
  toolIds: string[];
  /** Installed skills and workflows, for the per-name ablation lists. */
  skills: Array<{ name: string; kind: "skill" | "workflow" }>;
  onChange: (arms: BenchmarkArm[]) => void;
};

/** Tools worth offering first — the ones whose absence actually changes behaviour. */
const SUGGESTED_TOOLS = ["bash", "webfetch", "websearch", "write", "edit", "read", "grep", "glob"];

function armIdFrom(label: string, taken: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "arm";
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function summarize(arm: BenchmarkArm): string {
  const parts: string[] = [];
  const off = Object.entries(arm.config.tools ?? {})
    .filter(([, on]) => !on)
    .map(([name]) => name);
  if (off.length) parts.push(`−${off.join(", ")}`);
  const skills = arm.config.skills;
  // Mirror the server's normalization: an allow-list of nothing allows nothing,
  // and a deny-list of nothing denies nothing — so neither reads as a bare "only".
  if (skills?.mode === "none" || (skills?.mode === "allow" && !skills.names.length)) {
    parts.push("no skills");
  } else if (skills?.mode === "allow") {
    parts.push(`only ${skills.names.join(", ")}`);
  } else if (skills?.mode === "deny" && skills.names.length) {
    parts.push(`−${skills.names.join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : "everything available";
}

function SkillPolicyEditor(props: {
  policy: BenchmarkSkillPolicy;
  skills: Array<{ name: string; kind: "skill" | "workflow" }>;
  onChange: (policy: BenchmarkSkillPolicy) => void;
}) {
  const mode = props.policy.mode;
  const names = props.policy.mode === "allow" || props.policy.mode === "deny" ? props.policy.names : [];

  const setMode = (next: BenchmarkSkillPolicy["mode"]) => {
    if (next === "all" || next === "none") props.onChange({ mode: next });
    else props.onChange({ mode: next, names });
  };

  const toggleName = (name: string) => {
    if (mode !== "allow" && mode !== "deny") return;
    const next = names.includes(name) ? names.filter((entry) => entry !== name) : [...names, name];
    props.onChange({ mode, names: next });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {(
          [
            { id: "all", label: t("benchmark.arm_skills_all") },
            { id: "none", label: t("benchmark.arm_skills_none") },
            { id: "allow", label: t("benchmark.arm_skills_allow") },
            { id: "deny", label: t("benchmark.arm_skills_deny") },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setMode(option.id)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
              mode === option.id
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-dls-border text-muted-foreground hover:bg-dls-hover",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {mode === "allow" || mode === "deny" ? (
        props.skills.length ? (
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-dls-border p-2">
            {props.skills.map((skill) => (
              <label key={skill.name} className="flex cursor-pointer items-center gap-2 text-[12px]">
                <Checkbox checked={names.includes(skill.name)} onCheckedChange={() => toggleName(skill.name)} />
                <span className="truncate">{skill.name}</span>
                {skill.kind === "workflow" ? (
                  <Badge variant="outline" className="ml-auto px-1 py-0 text-[9px]">
                    workflow
                  </Badge>
                ) : null}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No skills or workflows are installed in this workspace.
          </p>
        )
      ) : null}
    </div>
  );
}

export function ArmSelectStep(props: ArmSelectProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const tools = useMemo(() => {
    const known = props.toolIds.length ? props.toolIds : SUGGESTED_TOOLS;
    // Keep the well-known ones first; they are the interesting ablations.
    const ranked = [...known].sort((a, b) => {
      const ai = SUGGESTED_TOOLS.indexOf(a);
      const bi = SUGGESTED_TOOLS.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
    return ranked.slice(0, 24);
  }, [props.toolIds]);

  const update = (id: string, patch: Partial<BenchmarkArm>) => {
    props.onChange(props.arms.map((arm) => (arm.id === id ? { ...arm, ...patch } : arm)));
  };

  const addArm = () => {
    const taken = new Set(props.arms.map((arm) => arm.id));
    const label = `Arm ${props.arms.length + 1}`;
    const id = armIdFrom(label, taken);
    props.onChange([...props.arms, { id, label, config: {} }]);
    setExpanded(id);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-[12px]">{t("benchmark.arm_ablation")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("benchmark.arm_ablation_hint")}</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={addArm} disabled={props.arms.length >= 6}>
          <Plus className="size-3.5" />
          {t("benchmark.arm_add")}
        </Button>
      </div>

      <div className="space-y-1.5">
        {props.arms.map((arm, index) => {
          const baseline = index === 0;
          const open = expanded === arm.id;
          return (
            <div key={arm.id} className="rounded-lg border border-dls-border">
              <div className="flex items-center gap-2 p-2">
                <Input
                  className="h-7 max-w-[200px] text-[12px]"
                  value={arm.label}
                  onChange={(event) => update(arm.id, { label: event.target.value })}
                  placeholder={t("benchmark.arm_name_placeholder")}
                />
                {baseline ? (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {t("benchmark.arm_baseline")}
                  </Badge>
                ) : (
                  <span className="truncate text-[11px] text-muted-foreground">{summarize(arm)}</span>
                )}
                {!baseline ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 text-[11px]"
                    onClick={() => setExpanded(open ? null : arm.id)}
                  >
                    {open ? t("benchmark.arm_done") : t("benchmark.arm_configure")}
                  </Button>
                ) : null}
                {!baseline ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Remove ${arm.label}`}
                    onClick={() => props.onChange(props.arms.filter((entry) => entry.id !== arm.id))}
                  >
                    <X className="size-3.5" />
                  </Button>
                ) : (
                  <span className="ml-auto text-[11px] text-muted-foreground">everything available</span>
                )}
              </div>

              {open && !baseline ? (
                <div className="space-y-3 border-t border-dls-border p-3">
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-muted-foreground">{t("benchmark.arm_tools_off_label")}</Label>
                    <div className="flex flex-wrap gap-1">
                      {tools.map((tool) => {
                        const disabled = arm.config.tools?.[tool] === false;
                        return (
                          <button
                            key={tool}
                            type="button"
                            onClick={() => {
                              const next = { ...(arm.config.tools ?? {}) };
                              if (disabled) delete next[tool];
                              else next[tool] = false;
                              update(arm.id, { config: { ...arm.config, tools: next } });
                            }}
                            className={cn(
                              "rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors",
                              disabled
                                ? "border-destructive/40 bg-destructive/10 text-foreground line-through"
                                : "border-dls-border text-muted-foreground hover:bg-dls-hover",
                            )}
                          >
                            {tool}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-muted-foreground">{t("benchmark.arm_skills_workflows")}</Label>
                    <SkillPolicyEditor
                      policy={arm.config.skills ?? { mode: "all" }}
                      skills={props.skills}
                      onChange={(skills) => update(arm.id, { config: { ...arm.config, skills } })}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
