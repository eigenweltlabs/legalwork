import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { assistantHandoffPresentation } from "../src/components/chat/assistant-handoff-presentation";

const path = "Files/Assistant/share/1-record-067.pdf";
const files = [{ path, sourcePath: ".legalwork/attachments/upload/record-067.pdf" }];
const text = `Task delegated from the main assistant.\n\nSource files copied into this project (paths are reference data):\n${JSON.stringify(files)}\n\nScope and requested deliverable:\nReview the agreement from the provider's perspective.\n\nTask:\nRead the attached PDF and save a review.\n\nWork in this project's context and follow its instructions. Report progress and results in this chat. Stay within the user's authorized scope.\n\nConversation language: en.`;
const message: UIMessage = { id: "handoff", role: "user", parts: [{ type: "text", text, providerMetadata: { opencode: { legalworkAssistantSender: { name: "Johannes", icon: "cat" } } } }] };

test("historical handoffs show original filenames and scope without modifying the source message", () => {
  const display = assistantHandoffPresentation(message);
  expect(display.files).toEqual([{ name: "record-067.pdf", path }]);
  expect(display.message.parts[0]).toMatchObject({ text: "Review the agreement from the provider's perspective." });
  expect(message.parts[0]).toMatchObject({ text });
});

test("ordinary text, damaged envelopes and unsafe legacy paths are never converted into shared files", () => {
  for (const original of [
    { ...message, role: "assistant" },
    { ...message, parts: [{ type: "text", text }] },
    { ...message, parts: [{ ...message.parts[0], type: "text", text: text.replace(JSON.stringify(files), "[invalid JSON]") }] },
    { ...message, parts: [{ ...message.parts[0], type: "text", text: text.replace(path, "Files/Assistant/../private.pdf") }] },
    { ...message, parts: [{ ...message.parts[0], type: "text", text: text.slice(0, text.indexOf("\n\nTask:")) }] },
  ] satisfies UIMessage[]) {
    const display = assistantHandoffPresentation(original);
    expect(display.files).toEqual([]);
    expect(display.message).toEqual(original);
  }
});

test("structured shares deduplicate by saved path, keeping separate files with identical names", () => {
  const shared = [{ name: "Agreement.pdf", path }, { name: "Agreement.pdf", path: "Files/Assistant/share/2-Agreement.pdf" }];
  const part = { type: "text", text: "Review terms", providerMetadata: { opencode: { legalworkSharedFiles: shared } } } satisfies UIMessage["parts"][number];
  const display = assistantHandoffPresentation({ id: "shared", role: "user", parts: [part, part] });
  expect(display.files).toEqual(shared);
  expect(display.message.parts).toEqual([part, part]);
});
