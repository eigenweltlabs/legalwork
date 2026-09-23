import { expect, spyOn, test } from "bun:test";

import { installGithubSkills, scanGithubSkills } from "./github-skills.js";

// Shaped like lawve-ai/awesome-legal-skills: a SKILL.md with no frontmatter, in a
// folder whose workflow name (68 chars) was over the old 64-char cap.
const DIR = "skills/arbitration-clause-design-and-review-hafez-virjee";
const SKILL_MD = "# Arbitration Clause Design and Review\n## Purpose\nUse this skill to review arbitration clauses.\n";

const repoUrl = (dir: string) => `https://github.com/lawve-ai/awesome-legal-skills/tree/main/${dir}`;

function stubGithub(dir: string) {
  const fakeGithub = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/git/trees/main")) return Response.json({ tree: [{ type: "blob", mode: "100644", path: `${dir}/SKILL.md` }] });
    if (url.endsWith(`/main/${dir}/SKILL.md`)) return new Response(SKILL_MD);
    return new Response("not found", { status: 404 });
  };
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(fakeGithub, { preconnect: fetch.preconnect }));
}

test("imports a SKILL.md without frontmatter as a workflow, keeping its full name", async () => {
  const fetchSpy = stubGithub(DIR);
  try {
    const scan = await scanGithubSkills({ url: repoUrl(DIR) });
    expect(scan.skills.map((skill) => skill.description)).toEqual(["Use this skill to review arbitration clauses."]);

    const result = await installGithubSkills({ url: repoUrl(DIR), paths: [DIR], asWorkflow: true });
    expect(result.failed).toEqual([]);
    expect(result.skills.map((skill) => skill.name)).toEqual(["workflow-assistant-arbitration-clause-design-and-review-hafez-virjee"]);
    expect(Buffer.from(result.skills[0]!.files[0]!.contentBase64, "base64").toString("utf8")).toStartWith(
      [
        "---",
        "name: workflow-assistant-arbitration-clause-design-and-review-hafez-virjee",
        "description: Use this skill to review arbitration clauses.",
        "---",
        "<!-- Modified by LegalWork: skill name and workflow metadata adapted for import. -->",
        "# Arbitration Clause Design and Review",
      ].join("\n"),
    );
  } finally {
    fetchSpy.mockRestore();
  }
});

test("shortens a name over 200 chars by dropping whole trailing words", async () => {
  const folder = `${"very-long-clause-review-".repeat(9)}end`;
  const fetchSpy = stubGithub(`skills/${folder}`);
  try {
    const result = await installGithubSkills({ url: repoUrl(`skills/${folder}`), paths: [`skills/${folder}`], asWorkflow: true });
    const name = result.skills[0]!.name;
    expect(name.length).toBeLessThanOrEqual(200);
    expect(`workflow-assistant-${folder}`.startsWith(`${name}-`)).toBe(true);
  } finally {
    fetchSpy.mockRestore();
  }
});
