import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ProjectDetails } from "@legalwork/types/workspace";
import { ApiError } from "./errors.js";

const fieldSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().trim().min(1).max(100),
    labelSource: z.enum(["suggested", "custom"]).optional(),
    type: z.enum(["text", "number", "date", "select"]),
    value: z.union([z.string().max(4000), z.number().finite(), z.null()]),
    options: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.value === null || field.value === "") return;
    if (field.type === "number" && typeof field.value !== "number") {
      ctx.addIssue({
        code: "custom",
        message: "Number fields need a numeric value.",
      });
    } else if (field.type !== "number" && typeof field.value !== "string") {
      ctx.addIssue({
        code: "custom",
        message: "This field needs a text value.",
      });
    } else if (
      field.type === "select" &&
      !field.options?.includes(String(field.value))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Choose one of the field's options.",
      });
    } else if (field.type === "date") {
      const value = String(field.value);
      const date = new Date(`${value}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid calendar date.",
        });
      }
    }
  });
const fieldsSchema = z
  .array(fieldSchema)
  .max(50)
  .refine(
    (fields) => new Set(fields.map((field) => field.id)).size === fields.length,
    "Field IDs must be unique.",
  );
export function parseProjectFieldDefaults(input: unknown) {
  const parsed = fieldsSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_project_metadata", parsed.error.issues[0]?.message ?? "Invalid project fields.");
  return parsed.data.map((field) => ({ ...field, value: null }));
}

export async function initializeProjectFields(root: string, fields: ReturnType<typeof parseProjectFieldDefaults>) {
  const current = await readProjectDetails(root);
  // Reattaching a folder must preserve its existing schema and values, even if empty.
  if (current.revision > 0) return current;
  return updateProjectDetails(root, { revision: 0, fields });
}

const detailsSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  fields: fieldsSchema,
});
const patchSchema = z.object({
  revision: z.number().int().nonnegative(),
  fields: fieldsSchema,
});
const writes = new Map<string, Promise<unknown>>();

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function metadataPath(root: string, create: boolean) {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new ApiError(
      404,
      "project_folder_unavailable",
      "The project folder is unavailable. Reconnect it before editing project details.",
    );
  }
  const directory = join(root, ".legalwork");
  if (create) await mkdir(directory, { recursive: true });
  try {
    if ((await lstat(directory)).isSymbolicLink())
      throw new ApiError(
        400,
        "invalid_project_metadata",
        "Project metadata cannot use a linked folder.",
      );
    const path = join(directory, "project.json");
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new ApiError(
          400,
          "invalid_project_metadata",
          "Project metadata cannot use a linked file.",
        );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return path;
  } catch (error) {
    if (!missing(error)) throw error;
    return join(directory, "project.json");
  }
}

export async function readProjectDetails(
  root: string,
): Promise<ProjectDetails> {
  const path = await metadataPath(root, false);
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    const parsed = detailsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.message);
    return parsed.data;
  } catch (error) {
    if (missing(error)) return { version: 1, revision: 0, fields: [] };
    throw new ApiError(
      422,
      "invalid_project_metadata",
      "Project metadata could not be read. The existing file has been preserved.",
    );
  }
}

export async function updateProjectDetails(
  root: string,
  input: unknown,
): Promise<ProjectDetails> {
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_project_metadata",
      parsed.error.issues[0]?.message ?? "Invalid project metadata.",
    );
  const previous = writes.get(root) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readProjectDetails(root);
      if (parsed.data.revision !== current.revision) {
        throw new ApiError(
          409,
          "project_changed",
          "This project changed in another window. Reload before saving.",
        );
      }
      const updated: ProjectDetails = {
        version: 1,
        revision: current.revision + 1,
        fields: parsed.data.fields,
      };
      const path = await metadataPath(root, true);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
          flag: "wx",
        });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return updated;
    });
  writes.set(root, next);
  try {
    return await next;
  } finally {
    if (writes.get(root) === next) writes.delete(root);
  }
}

export function defaultProjectRoot(nativeDirectory?: string) {
  const root = process.env.LEGALWORK_PROJECTS_DIR?.trim() || nativeDirectory || join(homedir(), "LegalWork", "Projects");
  if (!isAbsolute(root)) throw new ApiError(400, "invalid_project_location", "The default project location must be an absolute folder. Choose your own folder or update the server setting.");
  return root;
}

/** Reserve a new visible folder; never reuse/overwrite a same-named project. */
export async function createDefaultProjectFolder(
  name: string,
  root = defaultProjectRoot(),
) {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .slice(0, 100)
    .replace(/[. ]+$/g, "");
  const stem =
    !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
      ? `Project-${cleaned || "new"}`
      : cleaned;
  await mkdir(root, { recursive: true });
  for (let index = 0; index < 1000; index++) {
    const path = join(root, index ? `${stem} (${index + 1})` : stem);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
  }
  throw new ApiError(
    409,
    "project_folder_exists",
    "Choose another project name.",
  );
}
