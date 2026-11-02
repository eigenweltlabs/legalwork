import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Process-owned server stores must exit before Windows can remove the fixture. */
export async function runNativeServerFixture(file: string, run: (root: string) => Promise<void>, options: {
  prefix: string;
  parentDirectory?: string;
  evidenceDirectory?: string;
}): Promise<void> {
  if (process.env.LEGALWORK_NATIVE_SERVER_FIXTURE_FILE === file) {
    const root = process.env.LEGALWORK_NATIVE_SERVER_FIXTURE_ROOT;
    if (!root) throw new Error("Native server fixture root is missing");
    await run(root);
    return;
  }
  if (options.evidenceDirectory) await mkdir(options.evidenceDirectory, { mode: 0o700 });
  const root = await realpath(options.evidenceDirectory ?? await mkdtemp(join(options.parentDirectory ?? tmpdir(), options.prefix)));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([process.execPath, "test", "--preload", fileURLToPath(new URL("../test-preload.ts", import.meta.url)),
      ...(process.env.LEGALWORK_TEST_CANDIDATE_DIRECTORY ? ["--preload", fileURLToPath(new URL("../../../packages/opencode-release/build/validation-preload.mjs", import.meta.url))] : []),
      file], {
      env: { ...process.env, LEGALWORK_NATIVE_SERVER_FIXTURE_FILE: file, LEGALWORK_NATIVE_SERVER_FIXTURE_ROOT: root },
      stdout: "inherit", stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`Native server fixture failed with exit code ${code}`);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    if (!options.evidenceDirectory) await rm(root, { recursive: true, force: true });
  }
}
