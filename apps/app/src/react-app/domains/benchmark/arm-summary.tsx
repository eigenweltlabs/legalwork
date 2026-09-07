/** @jsxImportSource react */

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BenchmarkArm, BenchmarkArmConfig } from "../../../app/lib/benchmark-types";

/**
 * What an ablation arm took away, for the run views.
 *
 * The start-run modal is where an arm is authored; once a run exists its config
 * is fixed and read-only, but it still has to be legible — a column labelled
 * "Arm 2" means nothing without the capabilities behind it.
 */

export type ArmRestrictions = {
  /** Tools switched off by name. */
  tools: string[];
  /** How skills and workflows are restricted, already normalized. */
  skills: { kind: "all" } | { kind: "none" } | { kind: "allow"; names: string[] } | { kind: "deny"; names: string[] };
};

/**
 * Normalizes the same way the server does, so the UI never claims a restriction
 * the run did not actually apply: an allow-list of nothing allows nothing, and
 * a deny-list of nothing denies nothing.
 */
export function armRestrictions(config: BenchmarkArmConfig | undefined): ArmRestrictions {
  const tools = Object.entries(config?.tools ?? {})
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  const skills = config?.skills;
  if (!skills || skills.mode === "all") return { tools, skills: { kind: "all" } };
  if (skills.mode === "none") return { tools, skills: { kind: "none" } };
  if (skills.mode === "allow") {
    return skills.names.length
      ? { tools, skills: { kind: "allow", names: skills.names } }
      : { tools, skills: { kind: "none" } };
  }
  return skills.names.length
    ? { tools, skills: { kind: "deny", names: skills.names } }
    : { tools, skills: { kind: "all" } };
}

/** True when the arm restricts nothing at all (the baseline). */
export function isUnrestricted(config: BenchmarkArmConfig | undefined): boolean {
  const { tools, skills } = armRestrictions(config);
  return tools.length === 0 && skills.kind === "all";
}

/** One-line summary, for tight spots like a table header tooltip. */
export function armSummaryLine(config: BenchmarkArmConfig | undefined): string {
  const { tools, skills } = armRestrictions(config);
  const parts: string[] = [];
  if (tools.length) parts.push(`no ${tools.join(", ")}`);
  if (skills.kind === "none") parts.push("no skills or workflows");
  else if (skills.kind === "allow") parts.push(`only the ${skills.names.join(", ")} skill(s)`);
  else if (skills.kind === "deny") parts.push(`no ${skills.names.join(", ")}`);
  return parts.length ? parts.join("; ") : "everything available";
}

/** The full include/exclude breakdown for one arm. */
export function ArmDetail({ config, className }: { config: BenchmarkArmConfig | undefined; className?: string }) {
  const { tools, skills } = armRestrictions(config);
  if (tools.length === 0 && skills.kind === "all") {
    return <p className={cn("text-[12px] text-muted-foreground", className)}>Everything available — no ablation.</p>;
  }
  return (
    <div className={cn("space-y-1.5 text-[12px]", className)}>
      {tools.length ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">Tools off:</span>
          {tools.map((tool) => (
            <Badge key={tool} variant="outline" className="px-1.5 py-0 font-mono text-[10px] line-through">
              {tool}
            </Badge>
          ))}
        </div>
      ) : null}
      {skills.kind === "none" ? (
        <div className="text-muted-foreground">
          Skills &amp; workflows: <span className="text-foreground">none available</span>
        </div>
      ) : null}
      {skills.kind === "allow" || skills.kind === "deny" ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">
            {skills.kind === "allow" ? "Only these skills:" : "Skills off:"}
          </span>
          {skills.names.map((name) => (
            <Badge
              key={name}
              variant="outline"
              className={cn("px-1.5 py-0 text-[10px]", skills.kind === "deny" && "line-through")}
            >
              {name}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The run's arms, listed with what each one takes away. Renders nothing for a
 * run with a single unablated arm — every pre-ablation run is one of those, and
 * a section saying "Full: everything available" is pure noise there.
 */
export function RunArmsSection({ arms }: { arms: BenchmarkArm[] | undefined }) {
  if (!arms?.length) return null;
  if (arms.length === 1 && isUnrestricted(arms[0]?.config)) return null;

  return (
    <div className="rounded-xl border border-dls-border">
      <div className="border-b border-dls-border px-4 py-2">
        <h3 className="text-[13px] font-medium text-foreground">Ablation arms</h3>
        <p className="text-[11px] text-muted-foreground">
          Every task ran once per arm. The first arm is the baseline the others are read against.
        </p>
      </div>
      <div className="divide-y divide-dls-border">
        {arms.map((arm, index) => (
          <div key={arm.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="flex min-w-40 items-center gap-1.5">
              <span className="text-[13px] font-medium text-foreground">{arm.label}</span>
              {index === 0 ? (
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  baseline
                </Badge>
              ) : null}
            </span>
            <ArmDetail config={arm.config} className="min-w-0 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Arm label with its restrictions behind a tooltip, for table headers. */
export function ArmLabelWithTooltip({
  label,
  config,
}: {
  label: string;
  config: BenchmarkArmConfig | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help underline decoration-dotted underline-offset-2">{label}</span>
        }
      />
      <TooltipContent className="max-w-72">{armSummaryLine(config)}</TooltipContent>
    </Tooltip>
  );
}
