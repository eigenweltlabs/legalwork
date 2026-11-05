import { expect, test } from "bun:test";
import { getWorkspaceTaskLoadErrorDisplay } from "../src/app/utils";

const project = { id: "local", name: "Matter", path: "/projects/matter", workspaceType: "local" as const };

test("a disconnected cloud folder retains the actionable server error", () => {
  const message = 'Project "Matter" is unavailable. Open Nextcloud and sign in, then retry.';
  const display = getWorkspaceTaskLoadErrorDisplay(project, message);
  expect(display.message).toBe(message);
  expect(display.title).toBe(message);
});

test("project errors redact credential text before displaying the recovery message", () => {
  const display = getWorkspaceTaskLoadErrorDisplay(project, "Retry after Authorization: Bearer owt_test_secret at https://example.invalid/?token=private-value");
  expect(display.message).toContain("Bearer [redacted]");
  expect(display.message).toContain("?token=[redacted]");
  expect(display.message).not.toContain("owt_test_secret");
  expect(display.message).not.toContain("private-value");
  expect(display.title).toBe(display.message);
});
