import { test, expect } from "bun:test";
import {
  recipientFragment,
  recipientOptions,
} from "../src/react-app/domains/mail/mail-recipient-input";
import { MailClient } from "../src/react-app/domains/mail/mail-client";
import { MailOnboardingClient } from "../src/react-app/domains/mail/mail-onboarding-client";

test("recipient suggestions preserve earlier addresses, distinguish sources and deduplicate case-insensitively", () => {
  expect(recipientFragment("first@example.test; Ali")).toEqual({
    prefix: "first@example.test; ",
    query: "Ali",
  });
  expect(
    recipientOptions(
      "first@example.test; Ali",
      [{ name: "Alice", address: "alice@example.test", source: "personal" }],
      ["ALICE@example.test", "alicia@example.test"],
    ),
  ).toEqual([
    {
      value: "first@example.test; alice@example.test",
      label: "Alice · Personal contacts",
    },
    {
      value: "first@example.test; alicia@example.test",
      label: "Recent draft recipient",
    },
  ]);
});

test("onboarding requests optional contact scope only on explicit choice and preserves reconnect identity", async () => {
  const bodies: unknown[] = [];
  const client = new MailClient(
    "http://127.0.0.1:12345",
    "synthetic",
    async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      return Response.json({
        connectionId: "synthetic",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        expiresAt: Date.now() + 1000,
      });
    },
  );
  const api = new MailOnboardingClient(client);
  await api.begin("gmail", new AbortController().signal, "existing");
  await api.begin("gmail", new AbortController().signal, "existing", true);
  expect(bodies).toEqual([
    { provider: "gmail", reconnectAccountId: "existing" },
    { provider: "gmail", reconnectAccountId: "existing", contacts: true },
  ]);
});
