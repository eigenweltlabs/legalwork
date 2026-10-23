import { expect, test } from "bun:test";
import { createProjectRemoval } from "../src/react-app/domains/workspace/project-removal";

test("retrying native cleanup after deletion reuses the chat IDs without another server deletion", async () => {
  const flow = createProjectRemoval();
  let deletions = 0, attempts = 0;
  const remove = async () => {
    if (++deletions > 1) throw new Error("404: project no longer exists");
    return { sessionIds: ["chat", "child"], backupPath: "/chosen/Project backup" };
  };
  const finish = async (ids: string[]) => {
    expect(ids).toEqual(["chat", "child"]);
    if (++attempts === 1) throw new Error("Could not persist desktop workspace registry");
  };
  await expect(flow.run(remove, finish)).rejects.toThrow("registry");
  expect(flow.deleted).toBe(true);
  expect(flow.backupPath).toBe("/chosen/Project backup");
  expect((await flow.run(remove, finish)).backupPath).toBe("/chosen/Project backup");
  expect(deletions).toBe(1); expect(attempts).toBe(2);
});

test("a rejected server deletion remains reviewable and does not run local cleanup", async () => {
  const flow = createProjectRemoval();
  let token = "old", attempts = 0, finished = false;
  const remove = async () => {
    attempts++;
    if (token === "old") throw new Error("Project changed: review again");
    return { sessionIds: [] };
  };
  const finish = async () => { finished = true; };
  await expect(flow.run(remove, finish)).rejects.toThrow("review again");
  expect(flow.deleted).toBe(false); expect(finished).toBe(false);
  token = "reviewed";
  await flow.run(remove, finish);
  expect(attempts).toBe(2); expect(finished).toBe(true);
});
