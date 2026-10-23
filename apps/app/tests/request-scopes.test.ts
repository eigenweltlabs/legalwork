import { expect, test } from "bun:test";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";

test("batched endpoint identities retain remote-owned credentials without borrowing the local host token", () => {
  const local = { baseUrl: "http://local", token: "local-token", hostToken: "local-owner" };
  const workspace = { id: "rem_ws_a", workspaceType: "remote", legalworkHostUrl: "https://remote", legalworkToken: "collaborator" };
  const ordinary = resolveWorkspaceEndpoint(workspace, local);
  const owner = resolveWorkspaceEndpoint({ ...workspace, legalworkHostToken: "remote-owner" }, local);
  expect(ordinary?.hostToken).toBeUndefined();
  expect(owner?.hostToken).toBe("remote-owner");
  expect(ordinary?.token).toBe("collaborator");
  expect(owner?.workspaceId).toBe("ws_a");
});
