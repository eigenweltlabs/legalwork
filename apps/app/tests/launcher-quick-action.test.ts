import { expect, test } from "bun:test";
import type { AssistantContextItem } from "@legalwork/types/launcher";
import { launcherQuickActionInputs, missingLauncherQuickActionInputs } from "../src/react-app/launcher/launcher-quick-action";

test("quick actions request only missing inputs, including whitespace-only text", () => {
  const inputs = launcherQuickActionInputs([{ id: "clip", type: "clipboard", text: "Existing note", capturedAt: 1 }], " \n ");
  expect(missingLauncherQuickActionInputs(["arguments", "selection", "clipboard", "files"], inputs)).toEqual(["arguments", "selection", "files"]);
  expect(missingLauncherQuickActionInputs([], inputs)).toEqual([]);
});

test("blank captured text does not mask a later usable selection or clipboard entry", () => {
  const context: AssistantContextItem[] = [
    { id: "empty-selection", type: "selection", text: " ", sourceApp: null, sourceWindow: null, capturedAt: 1 },
    { id: "selection", type: "selection", text: "Clause to explain", sourceApp: "Word", sourceWindow: null, capturedAt: 2 },
    { id: "empty-clipboard", type: "clipboard", text: "\n", capturedAt: 1 },
    { id: "clipboard", type: "clipboard", text: "Supporting note", capturedAt: 2 },
  ];
  expect(launcherQuickActionInputs(context, "Explain simply")).toEqual({ selection: "Clause to explain", clipboard: "Supporting note", files: [], arguments: "Explain simply" });
});

test("file requirements accept real file or image paths without discarding existing context", () => {
  const context: AssistantContextItem[] = [
    { id: "file", type: "file", workspaceId: "matter", path: "agreement.docx", name: "Agreement", revision: null, sourceLabel: null },
    { id: "image", type: "image", workspaceId: "matter", path: "capture.png", name: "Capture", capture: "window", sourceApp: null, sourceWindow: null, capturedAt: 1 },
    { id: "unstaged-image", type: "image", path: null, name: "Pending", capture: "region", sourceApp: null, sourceWindow: null, capturedAt: 1 },
  ];
  const before = structuredClone(context);
  const inputs = launcherQuickActionInputs(context, "Compare");
  expect(inputs.files).toEqual(["agreement.docx", "capture.png"]);
  expect(missingLauncherQuickActionInputs(["files", "arguments"], inputs)).toEqual([]);
  expect(context).toEqual(before);
  expect(missingLauncherQuickActionInputs(["files"], launcherQuickActionInputs([context[2]!], ""))).toEqual(["files"]);
});
