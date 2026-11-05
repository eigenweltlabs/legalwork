import { expect, test } from "bun:test";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";

test("retired remote endpoints cannot enter batched metadata requests", () => {
  const local = { baseUrl: "http://local", token: "local-token", hostToken: "local-owner" };
  const workspace = { id: "rem_ws_a", workspaceType: "remote", legalworkHostUrl: "https://remote", legalworkToken: "collaborator" };
  const ordinary = resolveWorkspaceEndpoint(workspace, local);
  const owner = resolveWorkspaceEndpoint({ ...workspace, legalworkHostToken: "remote-owner" }, local);
  expect(ordinary).toBeNull();
  expect(owner).toBeNull();
});

test("metadata batches use the selected server credentials for local projects", () => {
  const selected = { baseUrl: "https://selected", token: "selected-client", hostToken: "selected-owner" };
  const endpoint = resolveWorkspaceEndpoint({ id: "ws_a", workspaceType: "local" }, selected);
  expect(endpoint?.baseUrl).toBe(selected.baseUrl);
  expect(endpoint?.token).toBe(selected.token);
  expect(endpoint?.hostToken).toBe(selected.hostToken);
  expect(endpoint?.workspaceId).toBe("ws_a");
});
