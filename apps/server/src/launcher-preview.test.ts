import { expect, test } from "bun:test";
import { assemblePreview, clampPreview, messagesPreview } from "./launcher-preview.js";

test("previews are clamped with a visible marker and chats show the latest turns last", () => {
  expect(clampPreview("  short  ")).toEqual({ text: "short", truncated: false });
  const long = clampPreview("a".repeat(7000), 100);
  expect(long.truncated).toBe(true);
  expect(long.text.length).toBe(101);
  const chat = messagesPreview([{ role: "user", text: "Erste Frage", time: 1 }, { role: "assistant", text: "Antwort", time: 2 }, { role: "user", text: "   ", time: 3 }]);
  expect(chat).toEqual({ text: "You: Erste Frage\n\nAssistant: Antwort", truncated: false });
  const clipped = messagesPreview([{ role: "user", text: "x".repeat(80), time: 1 }, { role: "assistant", text: "y".repeat(80), time: 2 }], 100);
  expect(clipped.truncated).toBe(true);
  expect(clipped.text.startsWith("Assistant: yyy")).toBe(true);
  expect(assemblePreview({ kind: "tasks", id: "t1", title: "Call", meta: ["open"], updatedAt: null }, { text: "Body", truncated: false }, "metadata")).toMatchObject({ kind: "tasks", source: "metadata", text: "Body", meta: ["open"] });
});
