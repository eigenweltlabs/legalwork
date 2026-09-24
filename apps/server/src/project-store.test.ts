import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createDefaultProjectFolder,
  readProjectDetails,
  updateProjectDetails,
} from "./project-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function folder() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-project-"));
  roots.push(root);
  return root;
}

test("default creation reserves separate folders, sanitizes names and leaves existing documents alone", async () => {
  const root = await folder();
  const first = await createDefaultProjectFolder("Matter / Alpha", root);
  await writeFile(join(first, "contract.txt"), "original");
  const second = await createDefaultProjectFolder("Matter / Alpha", root);
  expect(first).not.toBe(second);
  expect(dirname(first)).toBe(root);
  expect(dirname(second)).toBe(root);
  expect(basename(second)).toBe("Matter - Alpha (2)");
  expect(await readFile(join(first, "contract.txt"), "utf8")).toBe("original");
  expect(dirname(await createDefaultProjectFolder("../../escape", root))).toBe(
    root,
  );
});

test("metadata reads do not create files; typed fields survive reopening without moving documents", async () => {
  const root = await folder();
  await writeFile(join(root, "contract.txt"), "original");
  expect(await readProjectDetails(root)).toEqual({
    version: 1,
    revision: 0,
    fields: [],
  });
  expect(await readdir(root)).toEqual(["contract.txt"]);
  const saved = await updateProjectDetails(root, {
    revision: 0,
    fields: [
      { id: "client", label: "Client", type: "text", value: "Acme" },
      { id: "value", label: "Value", type: "number", value: 500 },
      { id: "due", label: "Deadline", type: "date", value: "2026-09-24" },
      {
        id: "status",
        label: "Status",
        type: "select",
        value: "Open",
        options: ["Open", "Closed"],
      },
    ],
  });
  expect(saved.revision).toBe(1);
  expect(await readProjectDetails(root)).toEqual(saved);
  expect(await readFile(join(root, "contract.txt"), "utf8")).toBe("original");
  expect(await readdir(join(root, ".legalwork"))).toEqual(["project.json"]);
});

test("simultaneous stale updates cannot silently overwrite a successful edit", async () => {
  const root = await folder();
  const results = await Promise.allSettled([
    updateProjectDetails(root, {
      revision: 0,
      fields: [{ id: "a", label: "A", type: "text", value: "one" }],
    }),
    updateProjectDetails(root, {
      revision: 0,
      fields: [{ id: "b", label: "B", type: "text", value: "two" }],
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect((await readProjectDetails(root)).revision).toBe(1);
});

test("malformed metadata is preserved and invalid field values are rejected", async () => {
  const root = await folder();
  for (const field of [
    { id: "a", label: "A", type: "number", value: "NaN" },
    { id: "a", label: "A", type: "date", value: "2026-02-30" },
    { id: "a", label: "A", type: "select", value: "Other", options: ["Open"] },
  ])
    await expect(
      updateProjectDetails(root, { revision: 0, fields: [field] }),
    ).rejects.toThrow();
  await mkdir(join(root, ".legalwork"));
  const path = join(root, ".legalwork", "project.json");
  await writeFile(path, "{broken");
  await expect(
    updateProjectDetails(root, { revision: 0, fields: [] }),
  ).rejects.toThrow("preserved");
  expect(await readFile(path, "utf8")).toBe("{broken");
});

test("metadata never follows a linked metadata directory outside the project", async () => {
  const root = await folder();
  const outside = await folder();
  await symlink(outside, join(root, ".legalwork"));
  await expect(
    updateProjectDetails(root, { revision: 0, fields: [] }),
  ).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
});


test("default folders use portable names on Windows and macOS", async () => {
  const root = await folder();
  for (const name of ["CON", "aux.txt", "LPT1", "COM9", "..", "Matter:Alpha?", "Trailing...  "]) {
    const created = await createDefaultProjectFolder(name, root);
    expect(dirname(created)).toBe(root);
    expect(basename(created)).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    expect(basename(created)).not.toMatch(/[<>:"/\\|?*]|[. ]$/);
  }
});

test("new-project field defaults are optional and never replace a folder's existing metadata", async () => {
  const { parseProjectFieldDefaults, initializeProjectFields } = await import("./project-store.js");
  const root = await folder();
  const fields = parseProjectFieldDefaults([
    { id: "client", label: "Client", type: "text", value: "must not become a default" },
    { id: "status", label: "Status", type: "select", options: ["Open", "Closed"], value: null },
    { id: "opened", label: "Opened on", type: "date", value: null },
  ]);
  expect(fields.every((field) => field.value === null)).toBe(true);
  const created = await initializeProjectFields(root, fields);
  expect(created.fields).toEqual(fields);
  const edited = await updateProjectDetails(root, {
    revision: created.revision, fields: [{ id: "existing", label: "Existing", type: "text", value: "Keep me" }],
  });
  expect(await initializeProjectFields(root, fields)).toEqual(edited);
  const cleared = await updateProjectDetails(root, { revision: edited.revision, fields: [] });
  expect(await initializeProjectFields(root, fields)).toEqual(cleared);
  expect(() => parseProjectFieldDefaults([{ id: "x", label: "", type: "text", value: null }])).toThrow();
});

test("an explicitly empty default schema is saved and stays empty when defaults change", async () => {
  const { initializeProjectFields, parseProjectFieldDefaults } = await import("./project-store.js");
  const root = await folder();
  const created = await initializeProjectFields(root, []);
  expect(created).toEqual({ version: 1, revision: 1, fields: [] });
  const laterDefaults = parseProjectFieldDefaults([{ id: "client", label: "Client", type: "text", value: null }]);
  expect(await initializeProjectFields(root, laterDefaults)).toEqual(created);
  expect(await readProjectDetails(root)).toEqual(created);
});
