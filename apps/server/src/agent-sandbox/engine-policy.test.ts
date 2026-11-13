import { expect, test } from "bun:test";
import { explicitFileApprovals, managedNetworkGuard, managedPermissionRules, sandboxEngineAgents, sandboxEnginePermissions } from "./engine-policy.js";

test("engine file-reader defaults do not turn allowed project commands into approval requests", () => {
  const defaults = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
  ];
  expect(explicitFileApprovals(defaults, [{ action: "shell", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }])).toEqual([defaults[0]]);
  expect(explicitFileApprovals(defaults, [{ action: "read", resource: "*.env", effect: "ask" }, { action: "read", resource: "*.env.*", effect: "ask" }, { action: "external_directory", resource: "*", effect: "ask" }])).toEqual(defaults);
  const deny = { permission: "read", pattern: "private/*", action: "deny" };
  expect(explicitFileApprovals([...defaults, deny], [])).toContainEqual(deny);
  expect(managedPermissionRules(explicitFileApprovals(defaults, []), [defaults[1]])).toContainEqual(defaults[1]);
});

test("the protected tool keeps shell permissions while the host shell stays denied", () => {
  expect(sandboxEnginePermissions([{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "deny" }]))
    .toEqual([{ action: "*", resource: "*", effect: "allow" }, { action: "legalwork_shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" }, { action: "webfetch", resource: "*", effect: "deny" }, { action: "websearch", resource: "*", effect: "deny" }]);
});

test("custom and built-in agents cannot restore the host shell", () => {
  const agents = sandboxEngineAgents({ custom: { permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "allow" }] } });
  for (const agent of Object.values(agents)) expect(agent.permissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" });
  expect(agents.custom.permissions).toContainEqual({ action: "legalwork_shell", resource: "*", effect: "allow" });
  expect(agents.plan).toBeDefined();
});

test("managed web tools retain permission rules while built-in network routes stay denied", () => {
  expect(sandboxEnginePermissions([{ action: "webfetch", resource: "*", effect: "ask" }, { action: "webfetch", resource: "https://private/*", effect: "deny" }, { action: "websearch", resource: "*", effect: "deny" }]))
    .toEqual([{ action: "legalwork_webfetch", resource: "*", effect: "ask" }, { action: "legalwork_webfetch", resource: "https://private/*", effect: "deny" }, { action: "legalwork_websearch", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" }, { action: "webfetch", resource: "*", effect: "deny" }, { action: "websearch", resource: "*", effect: "deny" }]);
});

test("existing chat web restrictions survive the managed tool migration", () => {
  const agent = [{ permission: "webfetch", pattern: "*", action: "deny" }, { permission: "legalwork_webfetch", pattern: "*", action: "allow" }];
  const old = [{ permission: "webfetch", pattern: "https://private/*", action: "deny" }];
  expect(managedPermissionRules(agent, old)).toEqual([{ permission: "webfetch", pattern: "*", action: "allow" }, ...old]);
  const guarded = [{ permission: "legalwork_webfetch", pattern: "https://private/*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" }, { permission: managedNetworkGuard, pattern: "*", action: "deny" }];
  expect(managedPermissionRules(agent, guarded)).toEqual(managedPermissionRules(agent, old));
});

test("legacy shell restrictions survive migration, including scoped and ask rules", () => {
  const agent = [{ permission: "bash", pattern: "*", action: "deny" }, { permission: "legalwork_shell", pattern: "*", action: "allow" }];
  for (const action of ["deny", "ask"]) {
    const legacy = [{ permission: "bash", pattern: "*", action }];
    expect(managedPermissionRules(agent, legacy)).toEqual([{ permission: "bash", pattern: "*", action: "allow" }, ...legacy]);
  }
  const scoped = { permission: "bash", pattern: "rm *", action: "deny" };
  expect(managedPermissionRules(agent, [scoped, { permission: managedNetworkGuard, pattern: "*", action: "deny" }])).toContainEqual(scoped);
  expect(managedPermissionRules(agent, [
    { permission: "legalwork_shell", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: managedNetworkGuard, pattern: "*", action: "deny" },
  ])).toEqual([{ permission: "bash", pattern: "*", action: "allow" }, { permission: "bash", pattern: "*", action: "deny" }]);
});
