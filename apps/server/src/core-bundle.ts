import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { LEGACY_CORE_MANIFESTS } from "./legacy-core-manifests.js";

const manifestSchema = z.object({
  version: z.literal(1), bundle: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
export type CoreManifest = z.infer<typeof manifestSchema>;
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
export function coreManifest(files: readonly { path: string; content: string }[]): CoreManifest {
  return { version: 1,
    bundle: createHash("sha1").update(files.map(file => `${file.path} ${file.content}`).join(" ")).digest("hex"),
    files: Object.fromEntries(files.map(file => [file.path, digest(file.content)])),
  };
}
export const CURRENT_CORE_MANIFEST = coreManifest(CORE_OPENCODE_FILES);

/** Immutable private receipts let later releases recognize their unchanged
 * predecessors without downloading old bundles or rewriting project copies. */
export async function rememberCoreManifest(root: string, manifest = CURRENT_CORE_MANIFEST) {
  const directory = join(root, "manifests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${manifest.bundle}.json`), JSON.stringify(manifest), { flag: "wx", mode: 0o600 })
    .catch(error => { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; });
}

async function originalManifest(project: string, library: string): Promise<CoreManifest | undefined> {
  try {
    for (const directory of [join(project, ".opencode"), join(project, ".opencode", "skills")]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
    }
    const path = join(project, ".opencode", ".legalwork-core"), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100 || info.size > 0 && info.blocks === 0) return;
    const bundle = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{40}$/.test(bundle)) return;
    if (bundle === CURRENT_CORE_MANIFEST.bundle) return CURRENT_CORE_MANIFEST;
    if (LEGACY_CORE_MANIFESTS[bundle]) return LEGACY_CORE_MANIFESTS[bundle];
    const manifestPath = join(library, "manifests", `${bundle}.json`), stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return;
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (parsed.success && parsed.data.bundle === bundle) return parsed.data;
  } catch { /* Missing, cloud-only and unknown versions preserve the project copy. */ }
}

const hashes = new Map<string, { metadata: string; digest: string }>();
async function unchangedFile(path: string, expected: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 0 && before.blocks === 0) return false;
  const metadata = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, before.mode].join(":");
  const cached = hashes.get(path);
  if (cached?.metadata === metadata) return cached.digest === expected;
  const hash = digest(await readFile(path)), after = await lstat(path);
  if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs, after.mode].join(":") !== metadata) return false;
  hashes.set(path, { metadata, digest: hash });
  return hash === expected;
}

/** Standalone bundled agents and commands use the same conservative receipts. */
export async function unchangedCoreFile(project: string, path: string, library: string): Promise<boolean> {
  const relativePath = relative(project, path).split(sep).join("/");
  if (!/^\.opencode\/(agents|commands)\/[^/]+\.md$/.test(relativePath)) return false;
  const manifest = await originalManifest(project, library), expected = manifest?.files[relativePath];
  if (!expected) return false;
  try { return (await lstat(join(library, relativePath))).isFile() && await unchangedFile(path, expected); }
  catch { return false; }
}

/** A skill is one package: a changed helper or extra resource preserves the
 * entire project override. Never infer ownership from SKILL.md alone. */
export async function unchangedCoreSkill(project: string, skillPath: string, library: string): Promise<boolean> {
  const path = relative(project, skillPath).split(sep).join("/");
  const match = /^\.opencode\/skills\/([^/]+)\/SKILL\.md$/.exec(path);
  if (!match) return false;
  // Never hide a usable project package when its shared replacement is absent.
  try { if (!(await lstat(join(library, path))).isFile()) return false; }
  catch { return false; }
  const manifest = await originalManifest(project, library);
  if (!manifest || !manifest.files[path]) return false;
  const prefix = `.opencode/skills/${match[1]}/`;
  const expected = new Map(Object.entries(manifest.files).filter(([path]) => path.startsWith(prefix)));
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<boolean> => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        const prefix = relative(project, target).split(sep).join("/") + "/";
        if (![...expected.keys()].some(path => path.startsWith(prefix)) || !await visit(target)) return false;
        continue;
      }
      const path = relative(project, target).split(sep).join("/"), hash = expected.get(path);
      if (!hash || !await unchangedFile(target, hash)) return false;
      seen.add(path);
    }
    return true;
  };
  try { return await visit(resolve(project, prefix)) && seen.size === expected.size; }
  catch { return false; }
}
