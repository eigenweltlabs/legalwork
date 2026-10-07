import { expect, test } from "bun:test";
import { sandboxEngineAgents, sandboxEnginePermissions } from "./engine-policy.js";

test("the protected tool keeps shell permissions while the host shell stays denied", () => {
  expect(sandboxEnginePermissions({ "*": "allow", bash: "ask", edit: "deny" }))
    .toEqual({ "*": "allow", edit: "deny", legalwork_shell: "ask", bash: "deny" });
});

test("custom and built-in agents cannot restore the host shell", () => {
  const agents = sandboxEngineAgents({ custom: { permission: { "*": "allow", bash: "allow" } } });
  for (const agent of Object.values(agents)) expect(agent.permission).toHaveProperty("bash", "deny");
  expect(agents.custom.permission).toHaveProperty("legalwork_shell", "allow");
  expect(agents.plan).toBeDefined();
});
