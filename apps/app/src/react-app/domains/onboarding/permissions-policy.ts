import type { OrgPolicyView } from "@legalwork/types/org-policy-view";

/** Skip only when every choice on the permissions step is locked. */
export function onboardingPermissionsEnforced(view: OrgPolicyView): boolean {
  const sandbox = view.entries.sandbox;
  const tools = view.entries["tools.permissions"];
  return Boolean(
    sandbox?.locked && !sandbox.released &&
    tools?.locked && !tools.released &&
    tools.value.edit !== undefined,
  );
}
