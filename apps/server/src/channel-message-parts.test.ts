import { describe, expect, test } from "bun:test";
import type { FilePartInput } from "@opencode-ai/sdk/v2/client";
import type { ChannelReceipt } from "./channel-runtime.js";
import { channelMessageParts } from "./channel-message-parts.js";

const input: Pick<ChannelReceipt, "id" | "channel" | "text"> = { id: "d2f0cfd9-30e1-4bed-9a1f-49d88ddc03b8", channel: "ios",
  text: "Kannst du dich bei PostHog einloggen und meine Analytics anschauen?" };
const file: FilePartInput = { type: "file", mime: "text/plain", filename: "report.txt", url: "file:///data/channel-inbox/report.txt" };

describe("channel browser capability context", () => {
  test("keeps the user's message, reaction identity and attachment while hiding runtime guidance", () => {
    const parts = channelMessageParts(input, [file], true);
    expect(parts.filter(part => part.type === "text" && !part.synthetic)).toEqual([
      { type: "text", text: input.text, metadata: { legalworkChannel: "ios", legalworkChannelEvent: input.id } },
    ]);
    expect(parts.at(-1)).toEqual(file);
    const reminder = parts.find(part => part.type === "text" && part.synthetic);
    expect(reminder?.type === "text" ? reminder.text : "").toContain('topic="cloud-browser"');
  });

  test("does not advertise cloud capabilities to a runtime without the cloud browser", () => {
    const parts = channelMessageParts(input, [], false);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text", text: input.text });
  });
});
