import { expect, test } from "bun:test";
import { noteTitle, projectFileDisplayName } from "../src/react-app/domains/workspace/project-note-title";

test("a note shows its title, and a sync conflict copy its title and whose version it is", () => {
  expect(noteTitle("Hallo-ee006b29.md")).toBe("Hallo");
  expect(noteTitle("Hallo-ee006b29 (Johann Machemer, 2026-09-27 14.06).md")).toBe("Hallo (Johann Machemer, 2026-09-27 14.06)");
  expect(noteTitle("Hallo-ee006b29 (Anna, 2026-09-27 14.06) (Ben, 2026-09-27 14.08).md")).toBe("Hallo (Anna, 2026-09-27 14.06) (Ben, 2026-09-27 14.08)");
  expect(noteTitle("Termin-2026.md")).toBe("Termin-2026");
  expect(projectFileDisplayName("Notes/Hallo-ee006b29 (Anna, 2026-09-27 14.06).md", "x")).toBe("Hallo (Anna, 2026-09-27 14.06)");
});
