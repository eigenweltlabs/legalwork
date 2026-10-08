import { expect, test } from "bun:test";
import { projectFileSourceSchema } from "@legalwork/types/project-files";
import { projectFileTab } from "../src/react-app/domains/workspace/project-file-tab";
import { usePanelTabStore, workspacePanelKey } from "../src/react-app/domains/session/panel/panel-tab-store";
import { createProjectAttachmentMention, parseWorkspaceAttachmentMention, workspaceAttachmentInstruction } from "../src/react-app/domains/session/surface/composer/workspace-attachment";
import { readProjectFileDrag, writeProjectFileDrag } from "../src/app/lib/project-file-drag";

const source = { projectId: "a", workspaceId: "a", path: "Contracts/same.docx", name: "Same.docx" };

test("foreign originals with equal relative paths remain distinct through cloning and restoration", () => {
  const scope = workspacePanelKey("target"); const store = () => usePanelTabStore.getState();
  store().clearSession(scope);
  store().openTab(scope, { id: "local", type: "artifact", label: source.name, value: source.path, preview: "word" });
  store().openTab(scope, projectFileTab(source));
  store().openTab(scope, projectFileTab({ ...source, projectId: "b", workspaceId: "b" }));
  const state = store().sessions[scope];
  expect(state.tabs).toHaveLength(3);
  const restored = store().readLayout(JSON.parse(JSON.stringify(state)));
  expect(restored?.tabs).toEqual(state.tabs);
  store().openTab(scope, projectFileTab(source));
  expect(store().sessions[scope].tabs).toHaveLength(3);
  store().clearSession(scope);
});

test("connected sources retain the original identity, excluding temporary working paths", () => {
  const tab = { ...projectFileTab({ ...source, connectionId: "drive" }), value: ".legalwork/storage/cache.docx" };
  const scope = workspacePanelKey("connected-target"); const store = () => usePanelTabStore.getState();
  store().openTab(scope, tab);
  const restored = store().readLayout(store().sessions[scope]);
  expect(restored?.tabs[0]).toEqual(projectFileTab({ ...source, connectionId: "drive" }));
  store().clearSession(scope);
});

test("source payloads reject traversal and keep no endpoint credentials", () => {
  for (const path of ["../a", "/etc/file", "a/../b", "C:/a", "a\\b", "a\u0000"]) expect(projectFileSourceSchema.safeParse({ ...source, path }).success).toBe(false);
  expect(projectFileSourceSchema.parse({ ...source, token: "never-share", baseUrl: "https://untrusted.invalid" })).toEqual(source);
  const values = new Map<string, string>();
  const data: Pick<DataTransfer, "types" | "effectAllowed" | "setData" | "getData"> = { types: [], effectAllowed: "copy", setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? "" };
  // The helper only needs the native data-transfer methods above.
  writeProjectFileDrag(data, source);
  expect(readProjectFileDrag(data)).toEqual(source);
});

test("pending chat references preserve the source; sent snapshots carry version and origin", () => {
  const mention = createProjectAttachmentMention(source, "Project A");
  expect(parseWorkspaceAttachmentMention(mention)).toMatchObject({ source, name: "Same.docx · Project A" });
  expect(parseWorkspaceAttachmentMention(mention)?.path).toStartWith("pending/");
  const saved = "attachment://workspace?name=Same.docx&path=.legalwork/attachments/unique/Same.docx&origin=Project+A&version=abc123";
  expect(workspaceAttachmentInstruction(saved)).toContain("SHA-256 abc123");
  expect(workspaceAttachmentInstruction(saved)).toContain("Project A");
});

test("queued snapshots retain resolved attachment mentions instead of pending sources", async () => {
  const { snapshotQueuedDraft } = await import("../src/react-app/domains/session/surface/use-session-message-queue");
  const { encodeComposerMentionValue } = await import("../src/react-app/domains/session/surface/composer/mention-encoding");
  const value = "attachment://workspace?name=contract.md&path=.legalwork/attachments/id/contract.md&origin=Source&originProject=a&originPath=contract.md&version=version-at-send";
  const text = `@${encodeComposerMentionValue(value)}`;
  const snapshot = await snapshotQueuedDraft({ mode: "prompt", text, resolvedText: text, parts: [], attachments: [] }, { draft: text, attachments: [], pasteParts: [], mentions: { [value]: "upload" } });
  expect(snapshot.editor.mentions[value]).toBe("upload");
  expect(parseWorkspaceAttachmentMention(value)?.source).toBeUndefined();
  expect(workspaceAttachmentInstruction(value)).toContain('source path "contract.md"');
  expect(workspaceAttachmentInstruction(value)).toContain("version-at-send");
  expect(workspaceAttachmentInstruction(createProjectAttachmentMention(source, "Source"))).toBe("");
});
