import { test, expect } from "bun:test";
import {
  recipientFragment,
  recipientOptions,
} from "../src/react-app/domains/mail/mail-recipient-input";
import { MailClient } from "../src/react-app/domains/mail/mail-client";
import { MailOnboardingClient } from "../src/react-app/domains/mail/mail-onboarding-client";
import { composeAccountLabel } from "../src/react-app/domains/mail/mail-composer";

test("composer account labels do not repeat an address as its own display name", () => {
  expect(composeAccountLabel("self@example.test <self@example.test>")).toBe("self@example.test");
  expect(composeAccountLabel("Jane Doe <jane@example.test>")).toBe("Jane Doe <jane@example.test>");
});

test("recipient suggestions preserve earlier addresses, show names and deduplicate case-insensitively", () => {
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
      address: "alice@example.test", name: "Alice",
    },
    {
      value: "first@example.test; alicia@example.test",
      address: "alicia@example.test", name: "",
    },
  ]);
});

test("recipient suggestions match correspondent names and discard stale results for another prefix", () => {
  expect(recipientOptions("Jane", [{ name: "Jane Doe", address: "legal@example.test", source: "recent" }, { name: "Alice", address: "alice@example.test", source: "personal" }], ["other@example.test"]))
    .toEqual([{ value: "legal@example.test", address: "legal@example.test", name: "Jane Doe" }]);
});

test("recipient autocomplete does not split a quoted display name",()=>{
 expect(recipientFragment('"Doe, Jane" <jane@example.test>; Ali')).toEqual({prefix:'"Doe, Jane" <jane@example.test>; ',query:'Ali'});
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
