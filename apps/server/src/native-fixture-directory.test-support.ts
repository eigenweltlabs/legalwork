import { mkdtemp, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

export async function nativeFixtureDirectory(prefix: string, insideRepository = false) {
  const parent = insideRepository ? process.env.LEGALWORK_TEST_NATIVE_REPO_FIXTURE_PARENT : process.env.LEGALWORK_TEST_NATIVE_FIXTURE_PARENT;
  return mkdtemp(parent ? join(parent, basename(prefix)) : prefix);
}

export async function removeNativeFixtureDirectory(directory: string) {
  const parents = [process.env.LEGALWORK_TEST_NATIVE_FIXTURE_PARENT, process.env.LEGALWORK_TEST_NATIVE_REPO_FIXTURE_PARENT].filter((parent): parent is string => Boolean(parent));
  if (parents.length) {
    if (!parents.some(parent => {
      const child = relative(parent, directory);
      return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    })) throw new Error("Native fixture is outside its parent-owned roots");
    // The child still owns process-level SQLite/file watchers. Its parent
    // verifies directory deletion after this test process actually exits.
    return;
  }
  await rm(directory, { recursive: true, force: true });
}
