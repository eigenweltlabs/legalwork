import { describe, expect, test } from "bun:test";
import {
  armIdFromLabel,
  BASELINE_ARM,
  describeArmRestrictions,
  needsSkillInterception,
  normalizeSkillPolicy,
  parseArmConfig,
  resolveSkillDecision,
  resolveToolOverrides,
  SKILL_TOOL,
} from "./ablation.js";

describe("skill policy", () => {
  test("the baseline arm restricts nothing", () => {
    expect(resolveSkillDecision(BASELINE_ARM.config.skills, "tabular-review").allowed).toBe(true);
    expect(resolveToolOverrides(BASELINE_ARM.config)).toBeUndefined();
    expect(describeArmRestrictions(BASELINE_ARM.config)).toBeNull();
    expect(needsSkillInterception(BASELINE_ARM.config)).toBe(false);
  });

  test("allow lists only the named skills", () => {
    const policy = { mode: "allow" as const, names: ["tabular-review"] };
    expect(resolveSkillDecision(policy, "tabular-review").allowed).toBe(true);
    const denied = resolveSkillDecision(policy, "docx-review");
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toContain("docx-review");
  });

  test("deny blocks only the named skills", () => {
    const policy = { mode: "deny" as const, names: ["tabular-review"] };
    expect(resolveSkillDecision(policy, "tabular-review").allowed).toBe(false);
    expect(resolveSkillDecision(policy, "docx-review").allowed).toBe(true);
  });

  test("skill names match case- and whitespace-insensitively", () => {
    const policy = { mode: "allow" as const, names: ["Tabular-Review"] };
    expect(resolveSkillDecision(policy, "  tabular-review ").allowed).toBe(true);
  });

  test("none blocks every skill", () => {
    expect(resolveSkillDecision({ mode: "none" }, "anything").allowed).toBe(false);
  });

  test("empty name lists collapse instead of reading backwards", () => {
    // An allow-list of nothing allows nothing; a deny-list of nothing denies nothing.
    expect(normalizeSkillPolicy({ mode: "allow", names: [] })).toEqual({ mode: "none" });
    expect(normalizeSkillPolicy({ mode: "deny", names: [] })).toEqual({ mode: "all" });
    expect(normalizeSkillPolicy(undefined)).toEqual({ mode: "all" });
  });
});

describe("tool overrides", () => {
  test("named tools pass through and omitted tools keep engine defaults", () => {
    expect(resolveToolOverrides({ tools: { bash: false, webfetch: true } })).toEqual({
      bash: false,
      webfetch: true,
    });
  });

  test("skills:none rides the tools map instead of needing the plugin", () => {
    expect(resolveToolOverrides({ skills: { mode: "none" } })).toEqual({ [SKILL_TOOL]: false });
    expect(needsSkillInterception({ skills: { mode: "none" } })).toBe(false);
  });

  test("named skill policies cannot be expressed as tools and need interception", () => {
    const config = { skills: { mode: "allow" as const, names: ["tabular-review"] } };
    expect(resolveToolOverrides(config)).toBeUndefined();
    expect(needsSkillInterception(config)).toBe(true);
  });

  test("a tool ablation and a skill ablation combine", () => {
    expect(resolveToolOverrides({ tools: { bash: false }, skills: { mode: "none" } })).toEqual({
      bash: false,
      [SKILL_TOOL]: false,
    });
  });
});

describe("restriction summary", () => {
  test("names what was taken away, and stays silent when nothing was", () => {
    const summary = describeArmRestrictions({
      tools: { bash: false, webfetch: true },
      skills: { mode: "deny", names: ["tabular-review"] },
    });
    expect(summary).toContain("bash");
    // Enabled tools are not "restrictions" and must not be listed as such.
    expect(summary).not.toContain("webfetch");
    expect(summary).toContain("tabular-review");
    expect(describeArmRestrictions({ tools: { bash: true } })).toBeNull();
  });
});

describe("arm ids", () => {
  test("slugs labels and de-duplicates collisions", () => {
    const taken = new Set<string>();
    const first = armIdFromLabel("No skills", taken);
    taken.add(first);
    const second = armIdFromLabel("No skills!", taken);
    expect(first).toBe("no-skills");
    expect(second).toBe("no-skills-2");
  });

  test("falls back for labels with no slug characters", () => {
    expect(armIdFromLabel("!!!", new Set())).toBe("arm");
  });
});

describe("parseArmConfig", () => {
  test("round-trips a stored config", () => {
    const config = { tools: { bash: false }, skills: { mode: "none" as const } };
    expect(parseArmConfig(JSON.stringify(config))).toEqual(config);
  });

  test("malformed or missing json degrades to no restrictions", () => {
    expect(parseArmConfig(null)).toEqual({});
    expect(parseArmConfig("not json")).toEqual({});
    expect(parseArmConfig(JSON.stringify({ skills: { mode: "bogus" } }))).toEqual({});
  });
});
