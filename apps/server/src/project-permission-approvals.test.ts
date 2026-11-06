import { expect, test } from "bun:test";
import { projectPermissionEffect, rememberedProjectFolderRules, type ProjectPermissionApprovals } from "./project-permission-approvals.js";

test("remembered project grants override Ask while explicit project, agent and native Deny retain priority", () => {
  const settings: ProjectPermissionApprovals = {
    permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
    projectPermissionApprovals: [{ action: "external_directory", resources: ["/matters/approved/*"] }],
    agents: { restricted: { permissions: [{ action: "external_directory", resource: "*", effect: "deny" }] } },
  };
  expect(projectPermissionEffect(settings, "external_directory", ["/matters/approved/file"], "ask")).toBe("allow");
  expect(projectPermissionEffect(settings, "external_directory", ["/matters/unapproved/file"], "ask")).toBe("ask");
  expect(projectPermissionEffect(settings, "external_directory", ["/matters/approved/file"], "deny")).toBe("deny");
  expect(projectPermissionEffect(settings, "external_directory", ["/matters/approved/file"], "ask", "restricted")).toBe("deny");
  expect(rememberedProjectFolderRules(settings)).toEqual([{ action: "external_directory", resource: "/matters/approved/*", effect: "allow" }]);
  expect(rememberedProjectFolderRules(settings, "restricted")).toEqual([]);
  settings.permissions = [...settings.permissions ?? [], { action: "external_directory", resource: "/matters/approved/*", effect: "deny" }];
  expect(rememberedProjectFolderRules(settings)).toEqual([]);
});

test("generic saved action matching is lossless, all requested resources need grants, and intrinsic native allows stay unchanged", () => {
  const settings: ProjectPermissionApprovals = { projectPermissionApprovals: [{ action: "fixture.*", resources: ["record-17"] }] };
  expect(projectPermissionEffect(settings, "fixture.review", ["record-17"], "ask")).toBe("allow");
  expect(projectPermissionEffect(settings, "fixture.review", ["record-17", "record-19"], "ask")).toBe("ask");
  expect(projectPermissionEffect(settings, "fixture.review", [], "ask")).toBe("ask");
  expect(projectPermissionEffect(settings, "unrelated.native", ["record-19"], "allow")).toBe("allow");
  expect(rememberedProjectFolderRules(settings)).toEqual([]);
});
