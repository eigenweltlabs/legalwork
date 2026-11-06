import { readFile } from "node:fs/promises";
import { listGlobalSkills, listSkills, listSkillsInDir, type SkippedSkill } from "./skills.js";
import { parseFrontmatter } from "./frontmatter.js";
import { join } from "node:path";

/** The existing resolver supplies the engine. Managed mode uses the shared
 * library and private bundled core; native-project mode keeps project overrides. */
export async function resolveCapabilityLibrary(directory: string, globalOnly = false, coreRoot?: string) {
  const skipped: SkippedSkill[] = [];
  const core = coreRoot ? await listSkillsInDir(join(coreRoot, ".opencode", "skills"), "global", skipped) : [];
  const candidates = globalOnly ? [...core, ...await listGlobalSkills(skipped)] : [...await listSkills(directory, true, skipped), ...core];
  const seen = new Set<string>();
  const skills = candidates.filter(skill => !seen.has(skill.name) && Boolean(seen.add(skill.name)));
  const nativeSkills = await Promise.all(skills.map(async skill => {
    const { data, body } = parseFrontmatter(await readFile(skill.path, "utf8"));
    const metadata = data.metadata && typeof data.metadata === "object" ? Object.fromEntries(Object.entries(data.metadata)) : {};
    const boolean = (value: unknown) => typeof value === "boolean" ? value : value === 1 || ["true", "yes", "on", "1"].includes(String(value).toLowerCase()) ? true
      : value === 0 || ["false", "no", "off", "0"].includes(String(value).toLowerCase()) ? false : undefined;
    const autoinvoke = boolean(metadata["opencode/autoinvoke"]) ?? (boolean(data["disable-model-invocation"]) ? false : undefined);
    return { id: skill.name, name: skill.name, description: skill.description, path: skill.path, content: body,
      ...(autoinvoke === undefined ? {} : { autoinvoke }) };
  }));
  return { skills, nativeSkills, skipped };
}
