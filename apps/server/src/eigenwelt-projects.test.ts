import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IntakeClient } from "./eigenwelt-intake.js";
import { createRemoteProject, listRemoteProjects, patchRemoteProject, downloadRemoteProjectFile, PROJECT_CHUNK_BYTES, type RemoteProjectFile, uploadRemoteProjectFile } from "./eigenwelt-projects.js";
import { eigenweltProjectStorage, type RemoteFileIndex } from "./eigenwelt-project-storage.js";
import { ApiError } from "./errors.js";

/**
 * Documents move straight between this machine and the firm's storage over
 * links the platform signs. Here `fetch` plays both: the platform under
 * https://platform.test, the storage under https://storage.test.
 */

const client: IntakeClient = { platformURL: "https://platform.test", platformToken: "tok_secret" };
const PROJECT = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;
const dir = await mkdtemp(join(tmpdir(), "lw-project-transfer-"));

type Call = { method: string; url: string; authorization: string | null; body: Buffer | null };
const calls: Call[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function stubFetch(respond: (call: Call) => Response | Promise<Response>): void {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body;
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        authorization: headers.get("authorization"),
        body: typeof body === "string" ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : null,
      };
      calls.push(call);
      return respond(call);
    },
    { preconnect: originalFetch.preconnect },
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("project API transfers instructions, clearing, and nullable or missing rollout values without stripping them", async () => {
  const scope = { documents: false, notes: false, tasks: false, recordings: false, metadata: true, reviews: false, calendar: true };
  const project = { id: PROJECT, name: "Writing preferences", ownerUserId: "user_1", role: "owner", access: "members", memberIds: [], scope, fields: [], createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z" };
  stubFetch((call) => {
    if (call.method === "POST") return json({ project: { ...project, personalizationPrompt: "Formal English" } });
    if (call.method === "PATCH") return json({ project: { ...project, personalizationPrompt: "" }, applied: ["personalization"] });
    return json({ projects: [{ ...project, personalizationPrompt: null }, { ...project, personalizationPrompt: "Short paragraphs" }, project], nextCursor: null });
  });
  const created = await createRemoteProject(client, { id: PROJECT, name: project.name, fields: [], scope, access: "members", memberIds: [], personalizationPrompt: "Formal English" });
  expect(created.personalizationPrompt).toBe("Formal English");
  expect(JSON.parse(calls[0].body?.toString() ?? "{}")).toHaveProperty("personalizationPrompt", "Formal English");
  expect((await patchRemoteProject(client, PROJECT, { personalizationPrompt: "" })).project?.personalizationPrompt).toBe("");
  expect(JSON.parse(calls[1].body?.toString() ?? "{}")).toHaveProperty("personalizationPrompt", "");
  const list = await listRemoteProjects(client, {});
  expect(list.projects.map((item) => item.personalizationPrompt)).toEqual([null, "Short paragraphs", undefined]);
});

function memoryIndex(): RemoteFileIndex {
  const files = new Map<string, RemoteProjectFile>();
  let seq: number | null = null;
  return {
    seq: () => seq,
    files: () => [...files.values()],
    replace: (all, next) => {
      files.clear();
      for (const each of all) files.set(each.path.toLowerCase(), each);
      seq = next;
    },
    apply: (changes) => {
      for (const path of changes.removed) files.delete(path.toLowerCase());
      for (const each of changes.files) files.set(each.path.toLowerCase(), each);
      seq = changes.seq;
    },
    clear: () => {
      files.clear();
      seq = null;
    },
  };
}
const incomplete = () => json({ code: "conflict", message: "upload the missing chunks first", reason: "incomplete" }, 409);
const FILE = { contentType: "application/pdf", updatedByUserId: "user_1", updatedAt: "2026-09-25T12:00:00.000Z" };

describe("project documents over signed links", () => {
  test("uploads only the chunks the platform lacks, straight to storage, then commits", async () => {
    const bytes = Buffer.alloc(PROJECT_CHUNK_BYTES + 5, 3);
    const hash = sha(bytes);
    const stored = new Map<string, Buffer>();
    let commits = 0;
    let linkRequests = 0;
    stubFetch(async (call) => {
      if (call.url === `https://platform.test/api/projects/${PROJECT}/files`) {
        commits += 1;
        return commits === 1 ? incomplete() : json({ file: { path: "Klage.pdf", sha256: hash, size: bytes.byteLength, ...FILE } });
      }
      if (call.url === `https://platform.test/api/projects/${PROJECT}/blobs/${hash}`) {
        // Chunk 0 arrived in an earlier, interrupted round; links come a few at a time.
        linkRequests += 1;
        return json({ uploads: linkRequests === 1 ? [{ index: 1, url: "https://storage.test/chunk-1?X-Amz-Signature=abc" }] : [] });
      }
      if (call.url.startsWith("https://storage.test/") && call.method === "PUT") {
        stored.set(new URL(call.url).pathname, call.body ?? Buffer.alloc(0));
        return new Response(null, { status: 200 });
      }
      if (call.url === `https://platform.test/api/projects/${PROJECT}/blobs/${hash}/1`) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });

    const file = await uploadRemoteProjectFile(client, PROJECT, "Klage.pdf", bytes, "application/pdf", null);
    expect(file.sha256).toBe(hash);
    expect(commits).toBe(2);
    expect(linkRequests).toBe(2);
    expect(stored.get("/chunk-1")?.equals(bytes.subarray(PROJECT_CHUNK_BYTES))).toBe(true);
    const storage = calls.filter((call) => call.url.startsWith("https://storage.test/"));
    expect(storage.map((call) => call.authorization)).toEqual([null]);
    expect(calls.filter((call) => call.url.startsWith("https://platform.test/")).every((call) => call.authorization === "Bearer tok_secret")).toBe(true);
  });

  test("does not commit a file that changed while it was uploaded", async () => {
    const path = join(dir, "Schriftsatz.pdf");
    await writeFile(path, "Entwurf");
    const hash = sha(Buffer.from("Entwurf"));
    let linkRequests = 0;
    stubFetch(async (call) => {
      if (call.url.endsWith("/files")) return incomplete();
      if (call.url.endsWith(`/blobs/${hash}`)) {
        linkRequests += 1;
        return json({ uploads: linkRequests === 1 ? [{ index: 0, url: "https://storage.test/chunk-0" }] : [] });
      }
      if (call.url.startsWith("https://storage.test/")) {
        await writeFile(path, "Endfassung"); // saved again mid-upload
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    const upload = uploadRemoteProjectFile(client, PROJECT, "Schriftsatz.pdf", path, "application/pdf", null);
    await expect(upload).rejects.toMatchObject({ status: 409, code: "project_file_changed" });
    expect(calls.filter((call) => call.url.endsWith("/files"))).toHaveLength(1);
  });

  test("downloads a document chunk by chunk from storage", async () => {
    const parts = [Buffer.from("Klage "), Buffer.from("vom 25.09.")];
    const whole = Buffer.concat(parts);
    stubFetch((call) => {
      if (call.url.startsWith(`https://platform.test/api/projects/${PROJECT}/files/content`)) {
        return json({ sha256: sha(whole), size: whole.byteLength, chunks: ["https://storage.test/a?sig", "https://storage.test/b?sig"] });
      }
      if (call.url === "https://storage.test/a?sig") return new Response(new Uint8Array(parts[0]));
      if (call.url === "https://storage.test/b?sig") return new Response(new Uint8Array(parts[1]));
      throw new Error(`unexpected ${call.url}`);
    });

    const destination = join(dir, "download.pdf");
    const received = await downloadRemoteProjectFile(client, PROJECT, "Klage.pdf", destination);
    expect(received).toEqual({ size: whole.byteLength, sha256: sha(whole) });
    expect((await readFile(destination)).equals(whole)).toBe(true);
    expect(calls.filter((call) => call.url.startsWith("https://storage.test/")).map((call) => call.authorization)).toEqual([null, null]);
  });

  test("a review tells the firm which documents it reviews; a document or an earlier run does not", async () => {
    const commits: unknown[] = [];
    stubFetch((call) => {
      if (call.url.endsWith("/files")) {
        commits.push(JSON.parse(call.body?.toString("utf8") ?? "{}"));
        return json({ file: { path: "x", sha256: "0".repeat(64), size: 1, ...FILE } });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const storage = eigenweltProjectStorage(client, PROJECT);
    const id = "7a1f3c2e-5b4d-4e6f-8a9b-0c1d2e3f4a5b";
    const review = {
      id, name: "Prüfung", sessionId: null, revision: 0, createdAt: 1, updatedAt: 1,
      settings: { mode: "llm", jev: null, llm: { providerId: "firm", model: "chat" } }, columns: [],
      documents: [{ id: "d", path: "Verträge/Kaufvertrag.pdf", name: "Kaufvertrag.pdf", sourceHash: null, status: "pending", completedPages: 0, pageCount: 0, error: null }],
      cells: [], status: "draft", runId: null, error: null,
    };
    const bytes = Buffer.from(JSON.stringify(review));
    await storage.write(`.legalwork/reviews/${id}.json`, bytes, "application/json", { createOnly: true });
    await storage.write(`.legalwork/reviews/history/${id}-${id}.json`, bytes, "application/json", { createOnly: true });
    await storage.write("Verträge/Kaufvertrag.pdf", Buffer.from("pdf"), "application/pdf", { createOnly: true });
    expect(commits).toMatchObject([{ reviewSources: ["Verträge/Kaufvertrag.pdf"] }, {}, {}]);
    expect(commits.slice(1).some((commit) => typeof commit === "object" && commit !== null && "reviewSources" in commit)).toBe(false);
  });

  test("a kept listing asks only what changed since, and lists whole again when told to", async () => {
    const index = memoryIndex();
    const file = (path: string, sha256: string) => ({ path, sha256, size: 1, ...FILE });
    const answers = [
      json({ files: [file("Klage.pdf", "a".repeat(64)), file("Vertrag.pdf", "b".repeat(64))], nextCursor: null, seq: 5 }),
      json({ reset: false, files: [file("Notes/Termin.md", "c".repeat(64))], removed: [{ path: "Klage.pdf" }], seq: 7, more: false }),
      json({ reset: true, files: [], removed: [], seq: 9, more: false }),
      json({ files: [file("Vertrag.pdf", "b".repeat(64))], nextCursor: null, seq: 9 }),
    ];
    stubFetch(() => answers.shift() ?? json({}, 500));
    const listed = async () =>
      ((await eigenweltProjectStorage(client, PROJECT, index).listFiles?.("")) ?? { entries: [] }).entries.map((entry) => entry.path).sort();

    expect(await listed()).toEqual(["Klage.pdf", "Vertrag.pdf"]);
    expect(await listed()).toEqual(["Notes/Termin.md", "Vertrag.pdf"]);
    expect(index.seq()).toBe(7);
    expect(await listed()).toEqual(["Vertrag.pdf"]);
    expect(calls.map((call) => new URL(call.url).search)).toEqual(["", "?since=5", "?since=7", ""]);
  });

  test("an expired or refused link fails the round, to be tried again", async () => {
    stubFetch((call) => {
      if (call.url.includes("/files/content")) return json({ sha256: "0".repeat(64), size: 1, chunks: ["https://storage.test/a?sig"] });
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    });
    const download = downloadRemoteProjectFile(client, PROJECT, "Klage.pdf", join(dir, "refused.pdf"));
    await expect(download).rejects.toBeInstanceOf(ApiError);
    await expect(download).rejects.toMatchObject({ status: 502, code: "project_storage_failed" });
  });
});
