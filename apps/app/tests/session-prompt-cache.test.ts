import { expect, test } from "bun:test";
import { buildSessionPromptRequest, nativePrompt } from "../src/app/lib/system-reminder";

test("app prompts save per-turn context in hidden history and preserve send options", () => {
  const input = { sessionID: "ses_fixture", model: { providerID: "fixture", modelID: "fixture" }, agent: "legalwork", variant: "high", reasoning_effort: "high", parts: [{ type: "text", text: "Question" }] } satisfies Parameters<typeof buildSessionPromptRequest>[0];
  // Guard the runtime boundary too: an accidental dynamic system field from a
  // caller must not escape in the actual request shared with the engine test.
  Reflect.set(input, "system", "Current time: changed");
  const first = buildSessionPromptRequest(input, " Initial app context ");
  const followUp = buildSessionPromptRequest({ ...input, parts: [{ type: "text", text: "Continue" }] }, "Updated app context");
  expect(nativePrompt(first)).not.toHaveProperty("system");
  expect(nativePrompt(first).text).toContain("<system-reminder>\nCurrent time: changed\n</system-reminder>");
  expect(first).toMatchObject({ sessionID: input.sessionID, model: input.model, agent: "legalwork", variant: "high", reasoning_effort: "high" });
  expect(first.parts[1]).toMatchObject({ type: "text", synthetic: true, text: "<system-reminder>\nInitial app context\n</system-reminder>" });
  expect(followUp.parts[1]).toMatchObject({ text: "<system-reminder>\nUpdated app context\n</system-reminder>" });
  expect(input.parts).toHaveLength(1);
  expect(first.parts[1]).toMatchObject({ text: "<system-reminder>\nInitial app context\n</system-reminder>" });
});
