import { z } from "zod";

export const nativePermissionRuleSchema = z.object({ action: z.string().min(1), resource: z.string(), effect: z.enum(["allow", "ask", "deny"]) }).strict();
export const nativeToolPermissionUpdatesSchema = z.record(z.string().min(1), z.array(nativePermissionRuleSchema).nullable()).superRefine((updates, context) => {
  for (const [action, rules] of Object.entries(updates)) {
    if (action === "external_directory") context.addIssue({ code: "custom", path: [action], message: "Folder grants belong to the selected project." });
    if (rules?.some(rule => rule.action !== action)) context.addIssue({ code: "custom", path: [action], message: "Each native rule must match its action key." });
  }
});
export type NativePermissionRule = z.infer<typeof nativePermissionRuleSchema>;
export type NativeToolPermissionUpdates = z.infer<typeof nativeToolPermissionUpdatesSchema>;

/** Editing one action leaves every unknown/concurrent action and its order intact. */
export function mergeNativeToolPermissionRules(current: ReadonlyArray<NativePermissionRule>, updates: NativeToolPermissionUpdates): NativePermissionRule[] {
  let result = [...current];
  for (const [action, rules] of Object.entries(updates)) {
    const index = result.findIndex(rule => rule.action === action);
    result = result.filter(rule => rule.action !== action);
    result.splice(index < 0 ? result.length : index, 0, ...rules ?? []);
  }
  return result;
}
