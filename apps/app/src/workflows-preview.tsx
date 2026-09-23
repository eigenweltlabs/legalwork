/** Development fixture: the real workflow library and editor, with in-memory files. */
import { useMemo, useState } from "react";
import type { SkillCard, SkillResourceCard } from "@/app/types";
import { WorkflowsView } from "@/react-app/domains/settings/pages/workflows-view";
import type { SkillsExtensionsStore } from "@/react-app/domains/settings/pages/skills-view";
import { newWorkflowContent } from "@/react-app/domains/settings/state/workflow-document";
import { resourceBase64, resourceBuffer } from "@/react-app/domains/settings/state/workflow-resource-store";

if (!import.meta.env.DEV) throw new Error("The workflow fixture is available only in development.");

function fixture(changed: () => void) {
  const definitions = [
    ["workflow-assistant-cite-check", "Check citations and verify quoted authorities.", "Cite Check"],
    ["workflow-assistant-depositions", "Prepare an outline grounded in the matter record.", "Depositions"],
    ["workflow-assistant-diligence", "Review a data room against the firm’s checklist.", "Diligence"],
    ["workflow-tabular-contract-comparison", "Compare key provisions across a set of agreements.", "Contract Comparison"],
    ["workflow-assistant-document-review", "Review a production with clear source references.", "Document Review"],
  ];
  if (new URLSearchParams(window.location.search).has("many")) {
    for (let index = 6; index <= 57; index++) {
      const number = String(index).padStart(2, "0");
      definitions.push([`workflow-assistant-matter-review-${number}`, `Review the matter record and prepare findings for practice ${number}.`, `Matter Review ${number}`]);
    }
  }
  const files = new Map(definitions.map(([name, description, title]) => [name, newWorkflowContent(name, description,
    `# ${title}\n\n${description}\n\n## Review approach\n\n- Establish the document inventory and flag gaps.\n- Cite the source and page for every finding.\n- Escalate uncertainty for **partner review**.\n\n## Deliverable\n\nProduce a memo with findings, source references, and open questions.`)]));
  let cards: SkillCard[] = definitions.map(([name, description]) => ({ name, description, path: `/preview/${name}/SKILL.md` }));
  const encode = (content: string) => resourceBase64(new TextEncoder().encode(content).buffer);
  const resources = new Map<string, string>([["playbook.md", encode("# Review playbook\n\nRecord sources and unresolved questions.")]]);
  let resourceCards: SkillResourceCard[] = [];
  const refreshResources = () => { resourceCards = [...resources].map(([name, content]) => ({ name, path: `resources/${name}`, size: atob(content).length })); changed(); };
  const unavailable = async () => { throw new Error("This action needs a connected workspace."); };
  const store: SkillsExtensionsStore & { workspaceContextKey: () => string } = {
    workspaceContextKey: () => "workflow-preview", skills: () => cards, skillsStatus: () => null,
    refreshSkills: async () => {}, readSkill: async (name) => files.has(name) ? { content: files.get(name) ?? "" } : null,
    saveSkill: async ({ name, content }) => {
      files.set(name, content);
      const description = content.match(/^description: (.+)$/m)?.[1];
      cards = cards.map((card) => card.name === name ? { ...card, description: description ? JSON.parse(description) : card.description } : card);
      changed();
    },
    createSkill: async ({ name, content, description }) => {
      if (files.has(name)) return { ok: false, message: "Already exists" };
      files.set(name, content); cards = [...cards, { name, description, path: `/preview/${name}/SKILL.md` }]; changed();
      return { ok: true, message: "Created" };
    },
    uninstallSkill: async (name) => { files.delete(name); cards = cards.filter((card) => card.name !== name); changed(); },
    skillResources: () => resourceCards, skillResourcesStatus: () => null,
    refreshSkillResources: async () => refreshResources(),
    readSkillResource: async (_skill, name, encoding) => {
      const content = resources.get(name);
      return content === undefined ? null : { name, path: `resources/${name}`, content: encoding === "base64" ? content : new TextDecoder().decode(resourceBuffer(content)) };
    },
    saveSkillResource: async (_skill, input) => { resources.set(input.name, input.contentBase64 ?? encode(input.content ?? "")); refreshResources(); return { ok: true, message: "Attached" }; },
    deleteSkillResource: async (_skill, name) => { resources.delete(name); refreshResources(); return { ok: true, message: "Removed" }; },
    hubSkills: () => [], hubSkillsStatus: () => null, hubRepo: () => null, hubRepos: () => [], ensureHubSkillsFresh: async () => {},
    refreshHubSkills: async () => {}, setHubRepo: async () => {}, addHubRepo: async () => {}, removeHubRepo: async () => {},
    installSkillCreator: unavailable, installHubSkill: unavailable, importLocalSkill: unavailable, importLocalSkillZip: unavailable,
    scanGithubSkills: unavailable, importGithubSkills: unavailable, revealSkillsFolder: unavailable, exportSkillZip: unavailable,
  };
  return store;
}

export function WorkflowsPreview() {
  const [, setRevision] = useState(0);
  const extensions = useMemo(() => fixture(() => setRevision((value) => value + 1)), []);
  return <WorkflowsView workspaceId="visual-workspace" workspaceName="Northstar Legal" busy={false} canInstallSkillCreator canUseDesktopTools extensions={extensions} onOpenLink={() => {}} createSessionAndOpen={() => {}} />;
}
