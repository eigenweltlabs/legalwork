import { describe, expect, test } from "bun:test";
import type { OrgPolicyView } from "@legalwork/types/org-policy-view";
import { onboardingPermissionsEnforced } from "../src/react-app/domains/onboarding/permissions-policy";

function policy(): OrgPolicyView {
  return {
    state: "active", orgId: "firm", orgName: "Firm", role: "member",
    revision: 1, platformURL: null, restored: null,
    entries: {
      sandbox: { mode: "enforced", locked: true, released: false, value: { enabled: true, networkMode: "approve" } },
      "tools.permissions": { mode: "enforced", locked: true, released: false, value: { edit: "ask", bash: "ask" } },
    },
  };
}

describe("onboarding permission policy", () => {
  test("skips only when sandbox, network and file editing are enforced", () => {
    expect(onboardingPermissionsEnforced(policy())).toBe(true);
  });

  test("keeps the step for personal and partially managed settings", () => {
    for (const entries of [
      {},
      { sandbox: policy().entries.sandbox },
      { "tools.permissions": policy().entries["tools.permissions"] },
    ]) {
      expect(onboardingPermissionsEnforced({ ...policy(), entries })).toBe(false);
    }
    const partial = policy();
    const tools = partial.entries["tools.permissions"]!;
    delete tools.value.edit;
    expect(onboardingPermissionsEnforced(partial)).toBe(false);
    tools.value.edit = "ask";
    delete tools.value.bash;
    expect(onboardingPermissionsEnforced(partial)).toBe(true);
  });

  test("defaults and policies released after sign-out remain editable", () => {
    const keys: ("sandbox" | "tools.permissions")[] = ["sandbox", "tools.permissions"];
    for (const key of keys) {
      const defaults = policy();
      const entry = defaults.entries[key]!;
      entry.mode = "default";
      entry.locked = false;
      expect(onboardingPermissionsEnforced(defaults)).toBe(false);
      entry.mode = "enforced";
      entry.locked = true;
      entry.released = true;
      expect(onboardingPermissionsEnforced(defaults)).toBe(false);
    }
  });
});
