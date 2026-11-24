import { expect, test } from "bun:test";
import { workdayStreams } from "../src/react-app/shell/workday-activity";
import { workdayTab } from "../src/react-app/shell/workday-surfaces";

test("one running chat changes visibility as focus moves to a document, another chat, or outside the app", () => {
  const doc = workdayTab({ id: "d", type: "artifact", label: "Vendor terms.docx", preview: "word",
    source: { workspaceId: "matter", workspaceRoot: "/files", projectName: "Matter" } }, "assistant", false)!;
  const chat = workdayTab({ id: "chat:a", type: "chat", sessionId: "a", label: "Compare vendor terms" }, "assistant", true)!;
  const runs = [{ projectId: "assistant", stream: "a", title: chat.title }, { projectId: "wiki", stream: "b", title: "Check precedent" }];
  const read = (resources: typeof chat[], focus: boolean, active = focus) => workdayStreams("window", "assistant", resources, runs, focus, active).filter(row => row.kind !== "window");
  const withChat = read([doc, chat], true);
  expect(withChat.map(row => [row.kind, row.agentVisibility])).toEqual([
    ["passive", undefined], ["foreground", undefined], ["agent", "foreground"], ["agent", "background"],
  ]);
  expect(withChat[0].projectId).toBe("matter");
  expect(read([{ ...doc, focused: true }], true).filter(row => row.kind === "agent").map(row => row.agentVisibility)).toEqual(["background", "background"]);
  expect(read([{ ...chat, id: "b", projectId: "wiki" }], true).at(-1)?.agentVisibility).toBe("foreground");
  expect(read([chat], false).filter(row => row.kind === "agent").every(row => row.agentVisibility === "background")).toBe(true);
  expect(read([chat], true, false).map(row => [row.kind, row.agentVisibility])).toEqual([
    ["passive", undefined], ["agent", "foreground"], ["agent", "background"],
  ]);
  expect(read([], true).find(row => row.kind === "agent")?.agentVisibility).toBe("background");
});
