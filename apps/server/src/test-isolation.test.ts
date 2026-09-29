import { expect, test } from "bun:test";
import { homedir, userInfo } from "node:os";

// test-preload.ts must be active: without it, a test's server opens the user's real runtime DB.
test("tests never resolve the real home folder", () => {
  expect(homedir()).not.toBe(userInfo().homedir);
});
