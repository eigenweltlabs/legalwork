import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusFolderAccess, corpusFolderEffect, type CorpusFolderPolicy } from "./folder-access.js";
import { CorpusService } from "./service.js";
import type { NativePermissionRule } from "../agent-sandbox/permissions.js";
import { ApprovalService } from "../approvals.js";
import type { Actor, ApprovalRequest, WorkspaceInfo } from "../types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "corpus-folders-"))); roots.push(base);
  const project = join(base, "matters", "1001-00002"), outside = join(base, "matters");
  await mkdir(join(outside, "1001-00001"), { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(join(outside, "1001-00001", "engagement-letter.txt"), "Responsible Partner: Beatrice Holloway");
  await writeFile(join(project, "memo.txt"), "Project memo");
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" };
  return { project, outside, workspace, pattern: `${outside}/*` };
}
const none: CorpusFolderPolicy = { permission: [], projectPermissionApprovals: [] };
const actor: Actor = { type: "remote", clientId: "wiki-agent:ses_child", scope: "owner" };
const chat = (sessionId: string) => async () => ({ sessionId, generation: "g1", actor });
const rule = (resource: string, effect: NativePermissionRule["effect"]): NativePermissionRule => ({ action: "external_directory", resource, effect });

test("a folder approved for the chat or project is searchable; any denial wins", () => {
  const f = { pattern: "/firm/matters/*" };
  const allowChat = [{ id: "ses_root", permissions: [rule(f.pattern, "allow")] }];
  expect(corpusFolderEffect(none, allowChat, [f.pattern])).toBe("allow");
  expect(corpusFolderEffect({ ...none, projectPermissionApprovals: [{ action: "external_directory", resources: [f.pattern] }] }, [], [f.pattern])).toBe("allow");
  expect(corpusFolderEffect(none, [], [f.pattern])).toBe("ask");
  // A general tool allow does not grant another filesystem folder.
  expect(corpusFolderEffect({ ...none, permission: [{ action: "*", resource: "*", effect: "allow" }] }, [], [f.pattern])).toBe("ask");
  expect(corpusFolderEffect({ permission: [rule(f.pattern, "deny")], projectPermissionApprovals: [] }, allowChat, [f.pattern])).toBe("deny");
  expect(corpusFolderEffect(none, [...allowChat, { id: "ses_parent", permissions: [rule("/firm/*", "deny")] }], [f.pattern])).toBe("deny");
  // Both the requested and the canonical folder must be approved.
  expect(corpusFolderEffect(none, allowChat, [f.pattern, "/elsewhere/matters/*"])).toBe("ask");
});

test("Allow once covers one search, Allow for this chat is remembered for the chat, and refusals do not search", async () => {
  const f = await fixture();
  const approvals = new ApprovalService({ mode: "manual", timeoutMs: 5000 });
  const asked: ApprovalRequest[] = [];
  const answer = async (reply: "allow" | "deny" | "always") => {
    while (!approvals.list().length) await Bun.sleep(1);
    const [request] = approvals.list(); asked.push(request); approvals.respond(request.id, reply);
  };
  const access = (sessionId: string, root = sessionId, policy = none) => corpusFolderAccess({ workspace: f.workspace, signal: new AbortController().signal, approvals,
    agent: chat(sessionId), lineage: async () => [{ id: sessionId }, { id: root }], policy: async () => policy });
  const search = async (sessionId: string, root: string, reply: "allow" | "deny" | "always") => (await Promise.all([access(sessionId, root)(f.outside), answer(reply)]))[0];
  expect(await search("ses_child", "ses_root", "allow")).toEqual({ folder: f.outside, canonical: f.outside });
  expect(asked[0]).toMatchObject({ action: "corpus.folder.search", sessionID: "ses_child", paths: [f.outside], canRemember: true });
  // Allow once does not cover the next search.
  await search("ses_child", "ses_root", "always");
  // Remembered for the parent chat, including its other subtasks, without another prompt.
  expect(await access("ses_other_child", "ses_root")(f.outside)).toEqual({ folder: f.outside, canonical: f.outside });
  expect(asked).toHaveLength(2);
  await expect(search("ses_new", "ses_new_root", "deny")).rejects.toMatchObject({ status: 403, code: "file_access_denied" });
  const denied: CorpusFolderPolicy = { permission: [rule(f.pattern, "deny")], projectPermissionApprovals: [] };
  await expect(access("ses_child", "ses_root", denied)(f.outside)).rejects.toMatchObject({ status: 403, message: expect.stringContaining("block") });
  expect(asked).toHaveLength(3);
  const noChat = corpusFolderAccess({ workspace: f.workspace, signal: new AbortController().signal, approvals, agent: async () => null, lineage: async () => [], policy: async () => none });
  await expect(noChat(f.outside)).rejects.toMatchObject({ status: 403, code: "file_access_denied" });
});

test("a search over an approved outside folder reads its files from that folder", async () => {
  const f = await fixture();
  const reads: Array<{ path: string; contentPath?: string }> = [];
  const service = new CorpusService({ selection: async () => ({ providerId: "configured", model: "jev" }),
    extract: async (_workspace, path, _signal, contentPath) => { reads.push({ path, contentPath }); return { text: path, pages: [{ page: 1, text: path }], complete: true, extraction: "native", hash: path }; },
    infer: async () => ({ model: "jev", answers: { answer: { type: "noul", noul: .97 } } }) });
  const question = "Does this document name Beatrice Holloway as responsible partner?";
  await expect(service.query(f.workspace, { paths: [f.outside], question })).rejects.toMatchObject({ status: 403, code: "file_access_denied" });
  const approve = async () => ({ folder: f.outside, canonical: f.outside });
  const result = await service.query(f.workspace, { paths: [f.outside], question, waitSeconds: 5 }, "outside", approve);
  const letter = join(f.outside, "1001-00001", "engagement-letter.txt");
  expect(result.results?.map(row => row.path).sort()).toEqual([letter, join(f.project, "memo.txt")]);
  expect(reads.every(read => read.contentPath === f.outside)).toBe(true);
  const evidence = await service.query(f.workspace, { jobId: result.jobId, evidencePath: letter, evidenceChunk: 0 });
  expect(evidence.passages?.[0]?.text).toBe(letter);
});
