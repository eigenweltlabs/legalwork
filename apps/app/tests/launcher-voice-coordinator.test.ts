import { expect, test } from "bun:test";
import { VoiceCoordinator } from "../src/react-app/launcher/voice-coordinator";

test("one capture owner: a second destination is refused until an explicit transition", () => {
  const voice = new VoiceCoordinator();
  const external = voice.request({ destination: "external", ownerId: "dictation", origin: { app: "Microsoft Word", window: "Lease.docx" } }, 10);
  expect(external.ok).toBe(true);
  const panel = voice.request({ destination: "assistant", ownerId: "panel", conversationId: "conv_1" }, 20);
  expect(panel).toMatchObject({ ok: false, reason: "busy", active: { destination: "external" } });
  // Opening the panel during external dictation leaves the destination unchanged.
  expect(voice.current()?.destination).toBe("external");
  expect(voice.release("panel")).toBe(false);
  const moved = voice.transition("dictation", { destination: "assistant", ownerId: "panel", conversationId: "conv_1" }, 30);
  expect(moved.ok).toBe(true);
  expect(voice.current()).toMatchObject({ destination: "assistant", ownerId: "panel", since: 30 });
  expect(voice.transition("dictation", { destination: "meeting", ownerId: "recorder" }).ok).toBe(false);
  expect(voice.release("panel")).toBe(true);
  expect(voice.request({ destination: "meeting", ownerId: "recorder" }).ok).toBe(true);
});
