import type { AssistantContextItem, QuickAction } from "@legalwork/types/launcher";

export function launcherQuickActionInputs(context: AssistantContextItem[], args: string) {
  return {
    selection: context.find((item): item is Extract<AssistantContextItem, { type: "selection" }> => item.type === "selection" && Boolean(item.text.trim()))?.text,
    clipboard: context.find((item): item is Extract<AssistantContextItem, { type: "clipboard" }> => item.type === "clipboard" && Boolean(item.text.trim()))?.text,
    files: context.flatMap(item => item.type === "file" || item.type === "image" ? item.path ? [item.path] : [] : []),
    arguments: args,
  };
}

export function missingLauncherQuickActionInputs(requires: QuickAction["requires"], inputs: ReturnType<typeof launcherQuickActionInputs>) {
  return requires.filter(input => input === "files" ? !inputs.files.length : !inputs[input]?.trim());
}
