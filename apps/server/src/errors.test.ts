import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, findApiError, projectFileError } from "./errors.js";

test("API errors from a separately bundled copy keep their status", async () => {
  // Mirrors the build: dist/project-storage-paths.js is bundled with its own ApiError.
  const outdir = await mkdtemp(join(tmpdir(), "legalwork-errors-"));
  try {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "project-storage-paths.ts")], outdir, target: "node", format: "esm" });
    expect(build.success).toBe(true);
    const bundled = await import(join(outdir, "project-storage-paths.js"));
    let thrown: unknown;
    try { bundled.resolveWorkspaceFile({ path: "/project" }, "/elsewhere/file.docx"); } catch (error) { thrown = error; }
    expect(findApiError(thrown)).toMatchObject({ status: 403, code: "file_access_denied" });
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});

test("subclasses keep ordinary instanceof checks", () => {
  class OtherError extends ApiError {}
  expect(new OtherError(409, "other", "Other") instanceof ApiError).toBe(true);
  expect(new ApiError(409, "plain", "Plain") instanceof OtherError).toBe(false);
  expect(new Error("plain") instanceof ApiError).toBe(false);
});

test.each([
  { code: "Unknown system error -81", errno: -81 },
  { code: "ENEEDAUTH" },
  { errno: -81 },
])("cloud authentication errors explain how to recover ($code)", (systemError) => {
  const cause = Object.assign(new Error("Unknown system error -81, read"), systemError);
  const error = projectFileError("/projects/Client matter", cause, "darwin");
  expect(error.status).toBe(503);
  expect(error.code).toBe("cloud_auth_required");
  expect(error.message).toContain("Client matter");
  expect(error.message).toContain("Folder: /projects/Client matter\n");
  expect(error.message).toContain("sign in");
  expect(error.message).toContain("Nextcloud");
  expect(error.details).toMatchObject({ reason: cause.message });
});

test.each(["EACCES", "EIO", "ETIMEDOUT"])("other file failures retain their real reason (%s)", (code) => {
  const cause = Object.assign(new Error(`${code}: cannot read project file`), { code });
  const error = projectFileError("/projects/Client matter", cause);
  expect(error.code).toBe("project_files_unavailable");
  expect(error.message).toContain(cause.message);
  expect(error.message).toContain("Folder: /projects/Client matter\n");
  expect(error.message).toContain("retry");
  expect(error.message).not.toContain("requires authentication");
  expect(error.message).not.toContain("sign in");
});

test.each([
  { code: "EACCES", errno: -13 },
  { code: "ENOENT", errno: -2 },
  { code: "EAUTH", errno: -80 },
  { code: "Unknown system error -810", errno: -810 },
  {},
])("the error text alone never triggers cloud sign-in advice ($code)", (systemError) => {
  const cause = Object.assign(new Error("Unknown system error -81, read"), systemError);
  expect(projectFileError("/projects/matter", cause, "darwin").code).toBe("project_files_unavailable");
});

test.each(["linux", "win32"])("an unknown numeric -81 is not diagnosed as cloud authentication on %s", (platform) => {
  const cause = Object.assign(new Error("Unknown system error -81, read"), { code: "Unknown system error -81", errno: -81 });
  const error = projectFileError("/projects/matter", cause, platform);
  expect(error.code).toBe("project_files_unavailable");
  expect(error.message).not.toContain("requires authentication");
});

test("existing API errors keep their status, code and message", () => {
  const error = new ApiError(422, "invalid_jsonc", "Failed to parse JSONC");
  expect(projectFileError("/projects/matter", error)).toBe(error);
});
