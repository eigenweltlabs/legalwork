import { expect, test } from "bun:test";
import type { ManagedEngineSettings } from "../managed-engine-settings.js";
import { registerManagedFolderPermissions } from "./managed-folder-permissions.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

test("native approvals are inherited live by nested helpers, with denials and unrelated chats preserved", async () => {
  const runtime = nativePluginTestRuntime("/fixture/matter");
  const settings: ManagedEngineSettings = { directory: "/fixture/matter", configuration: { permissions: [{ action: "fixture.review", resource: "*", effect: "ask" }] },
    sharedConfiguration: {}, projectPermissionApprovals: [], providerActivation: {} };
  runtime.sessions.set("parent", {});
  runtime.sessions.set("child", { parentID: "parent" });
  runtime.sessions.set("nested", { parentID: "child" });
  const hook = await registerManagedFolderPermissions(runtime.ctx, async () => settings);
  const evaluate = async (sessionID: string, resource = "same-document.pdf", effect: "allow" | "ask" | "deny" = "ask") => {
    const event = { sessionID, action: "fixture.review", resources: [resource], effect };
    await runtime.hook("permission", "evaluate", event);
    return event.effect;
  };
  try {
    expect(await evaluate("nested")).toBe("ask");
    runtime.sessions.set("parent", { permissions: [{ action: "fixture.review", resource: "same-document.pdf", effect: "allow" }] });
    expect(await evaluate("nested")).toBe("allow");
    expect(await evaluate("unrelated")).toBe("ask");
    expect(await evaluate("nested", "other-document.pdf")).toBe("ask");
    expect(await evaluate("nested", "same-document.pdf", "deny")).toBe("deny");
    runtime.sessions.set("child", { parentID: "parent", permissions: [{ action: "fixture.review", resource: "*", effect: "deny" }] });
    expect(await evaluate("nested")).toBe("deny");
    runtime.sessions.set("child", { parentID: "parent" });
    runtime.sessions.set("parent", {});
    expect(await evaluate("nested")).toBe("ask");
  } finally { await hook.dispose(); await runtime.close(); }
});
