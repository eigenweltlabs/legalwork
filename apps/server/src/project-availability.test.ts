import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { keepProjectStateDownloaded, requestWindowsFolderPin } from "./project-availability.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(parent = tmpdir()) {
  const root = await mkdtemp(join(parent, "LegalWork-offline-pin-"));
  roots.push(root);
  await mkdir(join(root, ".opencode", "skills", "example"), { recursive: true });
  await mkdir(join(root, ".legalwork"));
  await writeFile(join(root, ".opencode", "skills", "example", "SKILL.md"), "Synthetic skill\n");
  await writeFile(join(root, ".legalwork", "project.json"), "{}\n");
  await writeFile(join(root, "document.txt"), "Document outside the requested folders\n");
  return root;
}

test("ordinary folders and missing projects preserve their contents", async () => {
  const root = await fixture();
  await keepProjectStateDownloaded(join(root, "missing"));
  await Promise.all([keepProjectStateDownloaded(root), keepProjectStateDownloaded(root)]);
  expect(await readFile(join(root, "document.txt"), "utf8")).toBe("Document outside the requested folders\n");
  expect(await readFile(join(root, ".opencode", "skills", "example", "SKILL.md"), "utf8")).toBe("Synthetic skill\n");
});

test.skipIf(process.platform === "win32")("linked state folders are not pinned through their targets", async () => {
  const root = await fixture();
  const outside = await fixture();
  await rm(join(root, ".opencode"), { recursive: true });
  await symlink(join(outside, ".opencode"), join(root, ".opencode"));
  await keepProjectStateDownloaded(root);
  if (process.platform === "darwin") {
    const result = await exec("/usr/bin/xattr", [join(outside, ".opencode")]);
    expect(result.stdout).not.toContain("com.apple.fileprovider.pinned");
  }
});

test.skipIf(process.platform !== "win32")("real Windows interop compiles and rejects a non-cloud folder, including literal shell characters", async () => {
  const root = await fixture();
  const directory = join(root, "literal ' $() ü folder");
  await mkdir(directory);
  expect(await requestWindowsFolderPin(directory)).toBe("unsupported");
});

// Opt-in: real account integration. Only synthetic files under this new child
// are touched; never evict, unpin, rename, or read existing account documents.
const cloudRoot = process.env.LEGALWORK_CLOUD_PIN_TEST_ROOT;
test.skipIf(!cloudRoot || !["darwin", "win32"].includes(process.platform))("real cloud provider pins state folders, descendants and new children, while leaving documents alone", async () => {
  const root = await fixture(cloudRoot);
  if (process.platform !== "win32") await symlink(join(root, "document.txt"), join(root, ".opencode", "document-link"));
  if (process.platform === "darwin") {
    // Let the provider assign identifiers before checking its acknowledgement.
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await exec("/usr/bin/fileproviderctl", ["evaluate", join(root, ".opencode")]).catch(() => null);
      if (result?.stdout.includes("isKeepDownloaded")) break;
      await new Promise(done => setTimeout(done, 250));
    }
  }
  await keepProjectStateDownloaded(root);
  const newChild = join(root, ".opencode", "created-after-pin.md");
  await writeFile(newChild, "New child inherits offline availability\n");
  const pinned = [join(root, ".opencode"), join(root, ".legalwork"), join(root, ".opencode", "skills", "example", "SKILL.md"), newChild];
  for (const file of [...pinned, join(root, "document.txt")]) {
    let actual: boolean | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (process.platform === "darwin") {
        const result = await exec("/usr/bin/fileproviderctl", ["evaluate", file]).catch(() => null);
        const value = result?.stdout.match(/\bisKeepDownloaded\s*=\s*([01]);/)?.[1];
        if (value) actual = value === "1";
      } else {
        const result = await exec("attrib.exe", [file]);
        actual = result.stdout.split(file)[0].includes("P");
      }
      if (actual === pinned.includes(file)) break;
      await new Promise(done => setTimeout(done, 250));
    }
    expect(actual).toBe(pinned.includes(file));
  }
  expect(await readFile(newChild, "utf8")).toBe("New child inherits offline availability\n");
}, 30_000);
