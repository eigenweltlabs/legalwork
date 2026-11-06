import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Office project and chat pickers expose loading, empty, success and retry screens without a blocking startup overlay", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/office-pane.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  expect(result.exitCode).toBe(0);
  const screens: Array<{ state: string; html: string }> = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(screens).toHaveLength(5);
  for (const screen of screens) {
    expect(screen.html).not.toContain('data-testid="startup-screen"');
    expect(screen.html).toContain(screen.state === "sessions" ? 'aria-label="New session"' : 'aria-label="New workspace"');
    if (screen.state === "loading") expect(screen.html).toContain("Loading...");
    if (screen.state === "empty") expect(screen.html).toContain("No workspaces");
    if (screen.state === "projects") expect(screen.html).toContain("Office project fixture");
    if (screen.state === "error") expect(screen.html).toContain("Retry");
    if (screen.state === "sessions") expect(screen.html).toContain("Office chat fixture");
  }
});
