import type { SkillCard } from "@/app/types";

export type WorkflowType = "assistant" | "tabular";

export function isWorkflowCard(card: Pick<SkillCard, "name" | "kind">) {
  return card.kind === "workflow" || card.name.startsWith("workflow-");
}

export function workflowType(card: SkillCard): WorkflowType {
  return card.workflowType === "tabular" || card.name.startsWith("workflow-tabular-") ? "tabular" : "assistant";
}

export function workflowDisplayName(name: string) {
  return name.replace(/^workflow-(?:tabular|assistant)-/, "").replace(/^workflow-/, "")
    .replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const resourcesPattern = /(?:\r?\n)*<!-- legalwork:resources:start -->[\s\S]*?<!-- legalwork:resources:end -->(?:\r?\n)*/;

/** Keep metadata and the server-managed resource block out of the visual editor. */
export function readWorkflowDocument(content: string) {
  const match = content.match(/^(\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))([\s\S]*)$/);
  const frontmatter = match?.[1] ?? "";
  const rest = match?.[2] ?? content;
  const resources = rest.match(resourcesPattern)?.[0] ?? "";
  return { frontmatter, resources, body: rest.replace(resourcesPattern, "") };
}

/** Updating the description must retain unknown YAML fields and multiline values. */
export function writeWorkflowDocument(baseline: string, body: string, description?: string) {
  const document = readWorkflowDocument(baseline);
  let frontmatter = document.frontmatter;
  if (description !== undefined) {
    const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
    const line = `description: ${JSON.stringify(description.trim())}`;
    if (!frontmatter) frontmatter = `---${newline}${line}${newline}---${newline}`;
    else {
      const lines = frontmatter.split(newline);
      const start = lines.findIndex((value) => value.startsWith("description:"));
      if (start < 0) lines.splice(lines.length - (lines.at(-1) === "" ? 2 : 1), 0, line);
      else {
        let end = start + 1;
        while (end < lines.length && (/^[ \t]/.test(lines[end]) || lines[end] === "")) end++;
        lines.splice(start, end - start, line);
      }
      frontmatter = lines.join(newline);
    }
  }
  return `${frontmatter}${body}${document.resources}`;
}

export function workflowName(title: string, type: WorkflowType) {
  const slug = title.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `workflow-${type}-${slug}` : "";
}

export function workflowTitle(body: string, fallback: string) {
  return body.match(/^# (.+)$/m)?.[1]?.trim() || fallback;
}

export function renameWorkflowTitle(body: string, title: string) {
  const heading = `# ${title.replace(/[\r\n]/g, " ")}`;
  return /^# .+$/m.test(body) ? body.replace(/^# .+$/m, () => heading) : `${heading}\n\n${body}`;
}

export function newWorkflowContent(name: string, description: string, body: string) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${body.trim()}\n`;
}
