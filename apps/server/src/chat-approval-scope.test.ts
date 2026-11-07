import { expect, test } from "bun:test";
import { chatApprovalLineage } from "./chat-approval-scope.js";

const session = (id: string, parentID?: string, directory = "/fixture/matter") => ({ id, parentID, location: { directory } });

test("approval scope follows nested subtasks to their engine-owned parent chat", async () => {
  const sessions = new Map([session("root"), session("child", "root"), session("nested", "child")].map(item => [item.id, item]));
  expect((await chatApprovalLineage("nested", async id => {
    const item = sessions.get(id);
    if (!item) throw new Error("Missing session");
    return item;
  })).map(item => item.id)).toEqual(["nested", "child", "root"]);
});

test("approval ancestry rejects cycles, foreign projects and mismatched identities", async () => {
  await expect(chatApprovalLineage("child", async id => session(id, id))).rejects.toMatchObject({ code: "chat_approval_lineage" });
  await expect(chatApprovalLineage("child", async id => id === "child" ? session(id, "foreign") : session(id, undefined, "/other/project")))
    .rejects.toMatchObject({ code: "chat_approval_lineage" });
  await expect(chatApprovalLineage("child", async () => session("someone-else"))).rejects.toMatchObject({ code: "chat_approval_lineage" });
  await expect(chatApprovalLineage("0", async id => session(id, String(Number(id) + 1)))).rejects.toMatchObject({ code: "chat_approval_lineage" });
});
