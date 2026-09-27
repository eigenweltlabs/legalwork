import { describe, expect, test } from "bun:test";
import type { ContentSearchKind, ContentSearchResult } from "@legalwork/types/search";
import { rankSearchResults } from "../src/react-app/shell/search-ranking";

function result(kind: ContentSearchKind, title: string, updatedAt = 0, excerpt = ""): ContentSearchResult {
  return { kind, title, updatedAt, excerpt, id: `${kind}:${title}:${updatedAt}`, workspaceId: "workspace" };
}

describe("search result relevance", () => {
  test("an exact project and matching task stay ahead of hundreds of transcript and file hits", () => {
    const project = result("projects", "Acme acquisition");
    const task = result("tasks", "Acme acquisition closing checklist");
    const noise = Array.from({ length: 500 }, (_, index) => result(index % 2 ? "sessions" : "files",
      `Notes ${index}`, index + 100, "Acme acquisition ".repeat(500)));
    expect(rankSearchResults([...noise, task, project], "Acme acquisition").slice(0, 2)).toEqual([project, task]);
  });

  test("exact title matches win across types, then projects and tasks win equally strong matches", () => {
    const results = [result("files", "Acme"), result("sessions", "Acme"), result("tasks", "Acme"),
      result("projects", "Acme"), result("projects", "Acme closing")];
    expect(rankSearchResults(results, "Acme").map(item => `${item.kind}:${item.title}`)).toEqual([
      "projects:Acme", "tasks:Acme", "files:Acme", "sessions:Acme", "projects:Acme closing",
    ]);
  });

  test("prefix and phrase matches outrank scattered title terms and body matches", () => {
    const prefix = result("sessions", "Acme acquisition timeline");
    const phrase = result("files", "Notes on Acme acquisition.pdf");
    const scattered = result("projects", "Acquisition of Acme");
    const body = result("tasks", "Follow up", 1000, "Acme acquisition");
    expect(rankSearchResults([body, scattered, phrase, prefix], "Acme acquisition")).toEqual([prefix, phrase, scattered, body]);
  });

  test("case, spacing and decomposed Unicode do not weaken an exact project match", () => {
    const project = result("projects", "  Lu\u0308beck   Contracts ");
    const session = result("sessions", "Lübeck contracts discussion", 100);
    expect(rankSearchResults([session, project], " LÜBECK contracts ")[0]).toEqual(project);
  });

  test("recency breaks relevance ties and arrival order does not affect the result", () => {
    const older = result("tasks", "Review contract", 10);
    const newer = result("tasks", "Review contract", 20);
    expect(rankSearchResults([older, newer], "contract")).toEqual([newer, older]);
    const a = result("sessions", "Alpha", 100, "contract");
    const b = result("sessions", "Beta", 100, "contract");
    expect(rankSearchResults([a, b], "contract")).toEqual(rankSearchResults([b, a], "contract"));
  });

  test("empty search keeps recent sessions first and does not mutate the input", () => {
    const project = result("projects", "Acme");
    const older = result("sessions", "Old chat", 10);
    const newer = result("sessions", "New chat", 20);
    const items = [project, older, newer];
    expect(rankSearchResults(items, "  ")).toEqual([newer, older, project]);
    expect(items).toEqual([project, older, newer]);
  });

  test("completed tasks rank below equally relevant active tasks, but exact titles remain discoverable", () => {
    const done = { ...result("tasks", "Review contract", 200), completed: true };
    const active = result("tasks", "Review contract", 10);
    expect(rankSearchResults([done, active], "contract")).toEqual([active, done]);
    expect(rankSearchResults([done, active], "")).toEqual([active, done]);
    const incidental = result("tasks", "Send email", 300, "Review contract");
    expect(rankSearchResults([incidental, done], "Review contract")).toEqual([done, incidental]);
  });
});
