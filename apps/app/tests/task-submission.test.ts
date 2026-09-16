import { describe, expect, test } from "bun:test";

import { readTaskSubmission } from "../src/react-app/domains/tasks/task-submission";

describe("readTaskSubmission", () => {
  test("reads inbound mail from the { provider, item } envelope the platform stores", () => {
    const view = readTaskSubmission({
      channel: "email",
      senderEmail: "anna@kanzlei.de",
      receivedAt: "2026-09-14T09:40:00.000Z",
      rawPayload: {
        provider: "brevo",
        item: {
          From: { Name: "Anna Schmidt", Address: "anna@kanzlei.de" },
          To: [{ Name: null, Address: "nda-review-x7k2@intake.example.com" }],
          Subject: "NDA Acme",
          RawTextBody: "Bitte bis Freitag prüfen.",
          RawHtmlBody: "<p>Bitte bis Freitag prüfen.</p>",
        },
      },
    });

    expect(view).toEqual({
      from: "Anna Schmidt <anna@kanzlei.de>",
      to: "nda-review-x7k2@intake.example.com",
      subject: "NDA Acme",
      text: "Bitte bis Freitag prüfen.",
      html: "<p>Bitte bis Freitag prüfen.</p>",
      receivedAt: "2026-09-14T09:40:00.000Z",
      channel: "email",
    });
  });

  test("reads the API channel's flat payload", () => {
    const view = readTaskSubmission({
      channel: "api",
      senderEmail: "you@yourfirm.de",
      rawPayload: { channel: "api", submitter: "you@yourfirm.de", subject: "NDA review", text: "By Friday." },
    });

    expect(view?.from).toBe("you@yourfirm.de");
    expect(view?.subject).toBe("NDA review");
    expect(view?.text).toBe("By Friday.");
  });

  test("unwraps `item` only inside a provider envelope", () => {
    const view = readTaskSubmission({
      rawPayload: { subject: "Flat", item: { Subject: "Nested" } },
    });

    expect(view?.subject).toBe("Flat");
  });
});
