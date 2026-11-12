import { copyFile, mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { writeFixtureReleaseLibrary } from "../../../packages/opencode-release/test-fixture.mjs";

export async function cliFixture(root) {
  const source = path.join(root, "src"); await mkdir(source);
  for (const name of ["cli.ts", "legacy-developer-launcher.ts", "retired-messaging-tools.ts", "retired-binary-downloads.ts"])
    await copyFile(new URL(name, import.meta.url), path.join(source, name));
  await writeFixtureReleaseLibrary(path.join(root, "node_modules/@legalwork/opencode-release"));
  await mkdir(path.join(root, "node_modules/@opencode"), { recursive: true });
  await symlink(await realpath(new URL("../node_modules/@opencode/client", import.meta.url)), path.join(root, "node_modules/@opencode/client"), process.platform === "win32" ? "junction" : "dir");
  return path.join(source, "cli.ts");
}
