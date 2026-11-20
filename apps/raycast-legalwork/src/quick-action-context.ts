import { randomUUID } from "node:crypto";
import type { AssistantContextItem } from "@legalwork/types/launcher";

export function quickActionContext(selection: string, clipboard: string): AssistantContextItem[] {
  if (selection.length > 200_000) throw new Error("The selection exceeds 200,000 characters. Select a shorter passage and retry.");
  if (clipboard.length > 200_000) throw new Error("The clipboard text exceeds 200,000 characters. Copy a shorter passage and retry.");
  const items: AssistantContextItem[] = [];
  const capturedAt = Date.now();
  if (selection) items.push({ id: randomUUID(), type: "selection", text: selection, sourceApp: null, sourceWindow: null, capturedAt });
  if (clipboard) items.push({ id: randomUUID(), type: "clipboard", text: clipboard, capturedAt });
  return items;
}
