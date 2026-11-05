import { afterEach, expect, test } from "bun:test";
import { nativeFileEdits } from "./native-file-edits.js";
const prior = process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
afterEach(() => { if (prior === undefined) delete process.env.LEGALWORK_UI_CONTROL_DISCOVERY; else process.env.LEGALWORK_UI_CONTROL_DISCOVERY = prior; });

test("native writes hand off exact project files, then release once on failure or completion", async () => {
  process.env.LEGALWORK_UI_CONTROL_DISCOVERY = "/test/profile";
  const events: unknown[] = [];
  const edits = nativeFileEdits("/project", async (session, paths) => {
    events.push({ session, paths }); return async () => { events.push("reload"); };
  });
  await edits.before({ tool: "read", sessionID: "chat", callID: "read" }, { args: { filePath: "/project/report.md" } });
  await edits.before({ tool: "write", sessionID: "chat", callID: "external" }, { args: { filePath: "/other/report.md" } });
  expect(events).toEqual([]);
  await edits.before({ tool: "write", sessionID: "chat", callID: "write" }, { args: { filePath: "/project/report.md" } });
  await edits.after("chat", "write");
  await edits.after("chat", "write");
  expect(events).toEqual([{ session: "chat", paths: ["report.md"] }, "reload"]);
});

test("native patch and interrupted sessions reload each handed-off editor once", async () => {
  process.env.LEGALWORK_UI_CONTROL_DISCOVERY = "/test/profile";
  const completed: string[] = [];
  const edits = nativeFileEdits("/project", async session => async () => { completed.push(session); });
  await edits.before({ tool: "patch", sessionID: "first", callID: "patch" }, { args: {} });
  await edits.before({ tool: "edit", sessionID: "second", callID: "edit" }, { args: { filePath: "report.docx" } });
  await Promise.all([edits.finishSession("first"), edits.finishSession("first")]);
  expect(completed).toEqual(["first"]);
  await edits.dispose();
  await edits.dispose();
  expect(completed).toEqual(["first", "second"]);
});

test("headless native tools do not discover or mutate a different desktop profile", async () => {
  delete process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
  const edits = nativeFileEdits("/project", async () => { throw new Error("wrong profile"); });
  await edits.before({ tool: "edit", sessionID: "chat", callID: "call" }, { args: { filePath: "/project/report.md" } });
});
