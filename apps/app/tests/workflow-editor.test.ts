import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { newWorkflowContent, readWorkflowDocument, workflowName, writeWorkflowDocument } from "../src/react-app/domains/settings/state/workflow-document";
import { bindWorkflowServices, createWorkflow, discardWorkflow, editWorkflow, saveWorkflow, useWorkflowEditorStore, workflowDirty, type WorkflowDraft, type WorkflowServices } from "../src/react-app/domains/settings/state/workflow-editor-store";
import { confirmDiscardDocuments, registerUnsavedDocument } from "../src/react-app/domains/session/artifacts/docx-document-state";
import { discardWorkflowResource, editWorkflowResource, openWorkflowResource, resourceBase64, resourceBuffer, resourceDirty, saveWorkflowResource, useWorkflowResourceStore } from "../src/react-app/domains/settings/state/workflow-resource-store";
import { isDocumentWorkflowResource, isEditableWorkflowResource, isTextWorkflowResource, workflowResourceType } from "../src/react-app/domains/settings/state/workflow-resource-type";

const original = '---\nname: workflow-assistant-review\ndescription: "Review agreements"\ncustom:\n  rubric: private\n---\n\n# Review\n\nRead the agreement.\n';
const resources = '\n<!-- legalwork:resources:start -->\nUse resources/playbook.md\n<!-- legalwork:resources:end -->\n';

describe("workflow document preservation", () => {
  test("instructions edits preserve unknown metadata and managed attachments", () => {
    const baseline = original + resources;
    const parsed = readWorkflowDocument(baseline);
    const next = writeWorkflowDocument(baseline, parsed.body.replace('Read the agreement.', 'Check the governing law.'));
    assert.equal(next, baseline.replace('Read the agreement.', 'Check the governing law.'));
    assert.equal(writeWorkflowDocument(baseline, parsed.body), baseline);
  });

  test("editing a folded YAML description preserves adjacent fields and CRLF", () => {
    const baseline = '\uFEFF---\r\nname: test\r\ndescription: >-\r\n  Review the\r\n  agreement.\r\n\r\nmetadata:\r\n  keep: yes\r\n---\r\n# Review\r\n';
    const next = writeWorkflowDocument(baseline, readWorkflowDocument(baseline).body, 'Review "all" agreements: carefully');
    assert.ok(next.includes(`description: ${JSON.stringify('Review "all" agreements: carefully')}\r\nmetadata:`));
    assert.ok(next.includes('metadata:\r\n  keep: yes\r\n---\r\n# Review\r\n'));
    assert.ok(!next.includes('  agreement.'));
  });

  test("new tabular workflows retain their executable skill instruction", () => {
    const name = workflowName('Prüfung Verträge', 'tabular');
    assert.equal(name, 'workflow-tabular-prufung-vertrage');
    const content = newWorkflowContent(name, 'Review the documents', '# Review\n\nUse legalwork_review_settings and legalwork_review_start.');
    assert.ok(content.includes('name: workflow-tabular-prufung-vertrage'));
    assert.ok(content.includes('legalwork_review_start'));
    assert.ok(!content.includes('workflow_type:'));
  });
});

function setup() {
  let disk = original;
  let writes = 0;
  const body = readWorkflowDocument(original).body;
  const draft: WorkflowDraft = {
    id: 'test-workflow', workspaceId: 'test-workspace', contextKey: 'test', name: 'workflow-assistant-review', title: 'Review',
    description: 'Review agreements', savedDescription: 'Review agreements', type: 'assistant',
    body: body.replace('Read the agreement.', 'Check every clause.'), savedBody: body, baseline: original,
    isNew: false, loading: false, saving: false, error: null, staged: [],
  };
  const extensions: WorkflowServices['extensions'] = {
    skills: () => [{ name: draft.name, path: 'SKILL.md', description: draft.description }],
    readSkill: async () => ({ content: disk }),
    saveSkill: async (input) => { writes++; disk = input.content; },
    createSkill: async (input) => { writes++; disk = input.content; return { ok: true, message: '' }; },
    skillResources: () => [], skillResourcesStatus: () => null, refreshSkillResources: async () => {},
    readSkillResource: async () => null, saveSkillResource: async () => ({ ok: true, message: '' }), deleteSkillResource: async () => ({ ok: true, message: '' }),
  };
  useWorkflowEditorStore.setState({ drafts: { [draft.id]: draft }, services: {} });
  bindWorkflowServices(draft.workspaceId, { extensions, contextKey: 'test', currentContextKey: () => 'test', busy: false, canEdit: true, resources: [], resourceStatus: null });
  return { draft, extensions, disk: () => disk, setDisk: (value: string) => { disk = value; }, writes: () => writes, live: () => useWorkflowEditorStore.getState().drafts[draft.id] };
}

afterEach(() => {
  for (const id of Object.keys(useWorkflowResourceStore.getState().drafts)) discardWorkflowResource(id);
  for (const id of Object.keys(useWorkflowEditorStore.getState().drafts)) discardWorkflow(id);
  useWorkflowEditorStore.setState({ drafts: {}, services: {} });
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

async function setupResource(name = "playbook.md") {
  const fixture = setup();
  const events: Event[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: (event: Event) => { events.push(event); return true; } } });
  const resource = { name, path: `/skills/workflow-assistant-review/resources/${name}`, size: 20, updatedAt: 1 };
  let disk: { name: string; path: string; content: string } | null = { ...resource, content: isTextWorkflowResource(name) ? "# Playbook\r\n\r\nKeep exact whitespace.  \r\n" : "UEsDBAD/" };
  const writes: { skill: string; name: string; content?: string; contentBase64?: string }[] = [];
  fixture.extensions.readSkillResource = async (_skill, _name, encoding) => {
    assert.equal(encoding, "base64");
    return disk && { ...disk, content: isTextWorkflowResource(name) ? resourceBase64(new TextEncoder().encode(disk.content).buffer) : disk.content };
  };
  fixture.extensions.saveSkillResource = async (skill, input) => {
    writes.push({ skill, ...input });
    if (disk) disk = { ...disk, content: input.contentBase64 ?? input.content ?? "" };
    return { ok: true, message: "Saved" };
  };
  const id = await openWorkflowResource(fixture.draft.id, resource);
  assert.ok(id);
  return {
    ...fixture, id, resource, events, resourceWrites: writes,
    resourceDisk: () => disk, setResourceDisk: (value: typeof disk) => { disk = value; },
    resourceLive: () => useWorkflowResourceStore.getState().drafts[id],
  };
}

describe("attached workflow file tabs", () => {
  for (const name of ["template.docx", "template.xlsx", "template.pptx", "template.dotx"]) test(`${name} reads and saves binary bytes to the original resource`, async () => {
    const fixture = await setupResource(name);
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 255, 128, 1]);
    const content = resourceBase64(bytes.buffer);
    assert.deepEqual(new Uint8Array(resourceBuffer(content)), bytes);
    editWorkflowResource(fixture.id, { content, documentDirty: true });
    assert.equal(await saveWorkflowResource(fixture.id), true);
    assert.deepEqual(fixture.resourceWrites, [{ skill: fixture.draft.name, name, contentBase64: content }]);
    assert.equal(fixture.resourceLive().path, fixture.resource.path);
    assert.equal(fixture.resourceDisk()?.content, content);
    // The live editor clears its dirty flag only after confirming no newer edits.
    assert.equal(resourceDirty(fixture.resourceLive()), true);
    editWorkflowResource(fixture.id, { documentDirty: false });
    assert.equal(resourceDirty(fixture.resourceLive()), false);
  });

  test("every app file category has an editor, preview, or download fallback", () => {
    for (const [name, type] of [["a.md", "markdown"], ["a.txt", "text"], ["a.json", "text"], ["a.html", "html"], ["a.csv", "csv"], ["a.tsv", "csv"], ["a.docx", "word"], ["a.XLSX", "xlsx"], ["a.pptx", "pptx"], ["a.pdf", "pdf"], ["a.png", "image"], ["a.mp3", "audio"], ["a.mp4", "video"], ["a.zip", "external"], ["a.doc", "external"], ["a.xls", "external"], ["a.ppt", "external"]]) {
      assert.equal(workflowResourceType(name), type);
    }
    assert.equal(isDocumentWorkflowResource("a.csv"), true);
    assert.equal(isEditableWorkflowResource("a.json"), true);
  });

  for (const name of ["reference.pdf", "image.png", "recording.mp3", "clip.mp4", "archive.zip"]) test(`${name} opens without allowing a text write over its bytes`, async () => {
    const fixture = await setupResource(name);
    assert.equal(fixture.resourceLive().loaded, true);
    assert.equal(fixture.resourceLive().content, fixture.resourceDisk()?.content);
    editWorkflowResource(fixture.id, { content: "not binary" });
    assert.equal(await saveWorkflowResource(fixture.id), false);
    assert.equal(fixture.resourceWrites.length, 0);
  });

  test("text attachments preserve Unicode, BOM, and line endings through the binary read API", async () => {
    const fixture = await setupResource("config.json");
    const content = '\uFEFF{ "name": "Prüfung 法律" }\r\n';
    editWorkflowResource(fixture.id, { content });
    assert.equal(await saveWorkflowResource(fixture.id), true);
    await openWorkflowResource(fixture.draft.id, fixture.resource);
    assert.equal(fixture.resourceLive().content, content);
  });

  test("unsaved DOCX edits guard tab switching and failed saves preserve the draft", async () => {
    const fixture = await setupResource("template.docx");
    editWorkflowResource(fixture.id, { documentDirty: true });
    assert.equal(confirmDiscardDocuments(fixture.id, () => false, true), false);
    editWorkflowResource(fixture.id, { content: "UEsDBAD/AQ==" });
    fixture.extensions.saveSkillResource = async () => ({ ok: false, message: "Disk full" });
    assert.equal(await saveWorkflowResource(fixture.id), false);
    assert.equal(fixture.resourceLive().content, "UEsDBAD/AQ==");
    assert.equal(fixture.resourceLive().baseline, "UEsDBAD/");
    assert.equal(resourceDirty(fixture.resourceLive()), true);
    assert.equal(confirmDiscardDocuments(fixture.id, () => true, true), true);
    assert.equal(resourceDirty(fixture.resourceLive()), false);
    assert.equal(fixture.resourceLive().content, "UEsDBAD/");
  });

  test("opens a file tab and saves to the same workflow resource, preserving the workflow draft", async () => {
    const fixture = await setupResource();
    const event = fixture.events[0];
    assert.ok(event instanceof CustomEvent);
    assert.equal(event.detail.type, "workflow-resource");
    assert.equal(event.detail.label, "playbook.md");
    assert.equal(fixture.resourceLive().content, fixture.resourceDisk()?.content);
    assert.equal(resourceDirty(fixture.resourceLive()), false);
    editWorkflowResource(fixture.id, { content: "# Updated playbook\n\nUse the firm's rubric.\n" });
    assert.equal(await saveWorkflowResource(fixture.id), true);
    assert.deepEqual(fixture.resourceWrites, [{ skill: fixture.draft.name, name: "playbook.md", content: "# Updated playbook\n\nUse the firm's rubric.\n" }]);
    assert.equal(fixture.resourceLive().path, fixture.resource.path);
    assert.equal(fixture.live().body, fixture.draft.body);
    assert.equal(workflowDirty(fixture.live()), true);
    assert.equal(resourceDirty(fixture.resourceLive()), false);
  });

  test("failed file saves retain unsaved content and the original baseline", async () => {
    const fixture = await setupResource();
    const baseline = fixture.resourceLive().baseline;
    editWorkflowResource(fixture.id, { content: "A retained edit" });
    fixture.extensions.saveSkillResource = async () => ({ ok: false, message: "permission denied" });
    assert.equal(await saveWorkflowResource(fixture.id), false);
    assert.equal(fixture.resourceLive().content, "A retained edit");
    assert.equal(fixture.resourceLive().baseline, baseline);
    assert.equal(fixture.resourceLive().error, "permission denied");
  });

  test("edits made during a file save remain dirty", async () => {
    const fixture = await setupResource();
    editWorkflowResource(fixture.id, { content: "Submitted edit" });
    fixture.extensions.saveSkillResource = async () => {
      editWorkflowResource(fixture.id, { content: "Newer edit" });
      return { ok: true, message: "Saved" };
    };
    assert.equal(await saveWorkflowResource(fixture.id), true);
    assert.equal(fixture.resourceLive().baseline, "Submitted edit");
    assert.equal(fixture.resourceLive().content, "Newer edit");
    assert.equal(resourceDirty(fixture.resourceLive()), true);
  });

  test("external edits, moved paths, and deleted files cannot be overwritten or recreated", async () => {
    const fixture = await setupResource();
    const original = fixture.resourceDisk();
    assert.ok(original);
    editWorkflowResource(fixture.id, { content: "My edit" });
    for (const disk of [{ ...original, content: "Someone else's edit" }, { ...original, path: "/other/playbook.md" }, null]) {
      fixture.setResourceDisk(disk);
      assert.equal(await saveWorkflowResource(fixture.id), false);
    }
    assert.equal(fixture.resourceWrites.length, 0);
    assert.equal(fixture.resourceLive().content, "My edit");
  });

  test("switching or reopening retains file drafts; same names in different workflows get separate tabs", async () => {
    const fixture = await setupResource();
    editWorkflowResource(fixture.id, { content: "Unsaved attachment" });
    assert.equal(await openWorkflowResource(fixture.draft.id, fixture.resource), fixture.id);
    assert.equal(fixture.resourceLive().content, "Unsaved attachment");
    assert.equal(confirmDiscardDocuments(undefined, () => false, true), true);
    assert.equal(confirmDiscardDocuments(fixture.id, () => false), false);
    const other = { ...fixture.draft, id: "other-workflow", name: "workflow-assistant-other" };
    useWorkflowEditorStore.setState((state) => ({ drafts: { ...state.drafts, [other.id]: other } }));
    assert.notEqual(await openWorkflowResource(other.id, fixture.resource), fixture.id);
    assert.equal(confirmDiscardDocuments(fixture.id, () => true), true);
    assert.equal(useWorkflowResourceStore.getState().drafts[fixture.id], undefined);
  });

  test("a changed workspace binding cannot redirect a file save", async () => {
    const fixture = await setupResource();
    editWorkflowResource(fixture.id, { content: "My edit" });
    bindWorkflowServices(fixture.draft.workspaceId, { extensions: fixture.extensions, contextKey: "other", currentContextKey: () => "other", canEdit: true, busy: false, resources: [], resourceStatus: null });
    assert.equal(await saveWorkflowResource(fixture.id), false);
    assert.equal(fixture.resourceWrites.length, 0);
  });
});

describe("workflow setup dialog creation", () => {
  test("creates a saved document from the name and description before opening the editor", async () => {
    const fixture = setup();
    const created = await createWorkflow(fixture.draft.workspaceId, "assistant", { title: "  NDA Review  ", description: "  Review confidentiality terms.  " });
    assert.equal(fixture.writes(), 1);
    assert.equal(created.name, "workflow-assistant-nda-review");
    assert.equal(created.title, "NDA Review");
    assert.equal(created.description, "Review confidentiality terms.");
    assert.equal(created.isNew, false);
    assert.equal(workflowDirty(created), false);
    assert.equal(created.baseline, fixture.disk());
    assert.ok(created.body.startsWith("# NDA Review\n"));
    assert.equal(useWorkflowEditorStore.getState().drafts[created.id], created);
  });

  test("failed creation leaves no ghost draft or editor tab", async () => {
    const fixture = setup();
    fixture.extensions.createSkill = async () => ({ ok: false, message: "disk full" });
    await assert.rejects(createWorkflow(fixture.draft.workspaceId, "assistant", { title: "NDA", description: "Review NDAs" }), /disk full/);
    assert.deepEqual(Object.keys(useWorkflowEditorStore.getState().drafts), [fixture.draft.id]);
  });

  test("duplicate and empty names cannot overwrite an existing workflow", async () => {
    const fixture = setup();
    await assert.rejects(createWorkflow(fixture.draft.workspaceId, "assistant", { title: "Review", description: "Another review" }));
    await assert.rejects(createWorkflow(fixture.draft.workspaceId, "assistant", { title: "  ", description: "Another review" }));
    assert.equal(fixture.writes(), 0);
    assert.equal(fixture.disk(), original);
  });

  test("tabular creation includes its execution instruction without requiring sidebar edits", async () => {
    const fixture = setup();
    const created = await createWorkflow(fixture.draft.workspaceId, "tabular", { title: "Contract comparison", description: "Compare contracts" });
    assert.equal(created.name, "workflow-tabular-contract-comparison");
    assert.ok(created.body.includes("legalwork_review_start"));
    assert.equal(workflowDirty(created), false);
  });
});

describe("workflow saving", () => {
  test("rebinding the same workspace cannot redirect an existing instruction draft", async () => {
    const fixture = setup();
    bindWorkflowServices(fixture.draft.workspaceId, { extensions: fixture.extensions, contextKey: "other", currentContextKey: () => "other", canEdit: true, busy: false, resources: [], resourceStatus: null });
    assert.equal(await saveWorkflow(fixture.draft.id), false);
    assert.equal(fixture.writes(), 0);
    assert.equal(workflowDirty(fixture.live()), true);
  });

  test("a failed write retains the draft and dirty baseline", async () => {
    const fixture = setup();
    fixture.extensions.saveSkill = async () => { throw new Error('disk full'); };
    assert.equal(await saveWorkflow(fixture.draft.id), false);
    assert.equal(fixture.live().error, 'disk full');
    assert.equal(fixture.live().baseline, original);
    assert.equal(workflowDirty(fixture.live()), true);
    assert.equal(fixture.live().saving, false);
  });

  test("edits arriving during a save remain unsaved", async () => {
    const fixture = setup();
    fixture.extensions.saveSkill = async () => { editWorkflow(fixture.draft.id, { body: '# A newer edit' }); };
    assert.equal(await saveWorkflow(fixture.draft.id), true);
    assert.equal(fixture.live().body, '# A newer edit');
    assert.equal(fixture.live().savedBody, fixture.draft.body);
    assert.equal(workflowDirty(fixture.live()), true);
  });

  test("external instruction edits are detected before writing", async () => {
    const fixture = setup();
    fixture.setDisk(original.replace('Read the agreement.', 'An agent changed this.'));
    assert.equal(await saveWorkflow(fixture.draft.id), false);
    assert.equal(fixture.writes(), 0);
    assert.ok(fixture.disk().includes('An agent changed this.'));
    assert.equal(workflowDirty(fixture.live()), true);
  });

  test("newly attached resources are merged into the save", async () => {
    const fixture = setup();
    fixture.setDisk(original + resources);
    assert.equal(await saveWorkflow(fixture.draft.id), true);
    assert.ok(fixture.disk().includes('resources/playbook.md'));
    assert.ok(fixture.disk().includes('Check every clause.'));
    assert.ok(fixture.disk().includes('rubric: private'));
    assert.equal(workflowDirty(fixture.live()), false);
  });

  test("changing workspace prevents a draft from writing to the new target", async () => {
    const fixture = setup();
    bindWorkflowServices(fixture.draft.workspaceId, { extensions: fixture.extensions, contextKey: 'before', currentContextKey: () => 'after', busy: false, canEdit: true, resources: [], resourceStatus: null });
    assert.equal(await saveWorkflow(fixture.draft.id), false);
    assert.equal(fixture.writes(), 0);
  });

  test("failed attachment uploads keep a created workflow editable and retryable", async () => {
    const fixture = setup();
    editWorkflow(fixture.draft.id, { isNew: true, title: 'New review', staged: [{ name: 'playbook.md', size: 1, contentBase64: 'eA==' }] });
    fixture.extensions.saveSkillResource = async () => ({ ok: false, message: 'offline' });
    assert.equal(await saveWorkflow(fixture.draft.id), false);
    assert.equal(fixture.live().isNew, false);
    assert.equal(fixture.live().name, 'workflow-assistant-new-review');
    assert.equal(fixture.live().staged.length, 1);
    assert.equal(workflowDirty(fixture.live()), true);
  });

  test("successful staged uploads advance the resource baseline without dirtying instructions", async () => {
    const fixture = setup();
    editWorkflow(fixture.draft.id, { staged: [{ name: 'playbook.md', size: 1, contentBase64: 'eA==' }] });
    fixture.extensions.saveSkillResource = async () => {
      fixture.setDisk(fixture.disk() + resources);
      return { ok: true, message: '' };
    };
    assert.equal(await saveWorkflow(fixture.draft.id), true);
    assert.equal(fixture.live().baseline, fixture.disk());
    assert.equal(fixture.live().staged.length, 0);
    assert.equal(workflowDirty(fixture.live()), false);
  });
});

test("retained drafts switch without prompting but still protect close", () => {
  let discarded = false;
  const unregister = registerUnsavedDocument('workflow-close', 'Review', () => true, () => { discarded = true; }, true);
  try {
    assert.equal(confirmDiscardDocuments(undefined, () => false, true), true);
    assert.equal(discarded, false);
    assert.equal(confirmDiscardDocuments('workflow-close', () => false), false);
    assert.equal(confirmDiscardDocuments('workflow-close', () => true), true);
    assert.equal(discarded, true);
  } finally { unregister(); }
});
