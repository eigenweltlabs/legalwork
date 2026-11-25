import assert from "node:assert/strict";
import { test } from "node:test";

import { createConsentGatedTransport, scrubBreadcrumb, scrubEvent, scrubText } from "./error-reporting-scrub.mjs";

test("scrubText removes paths, e-mails, URL parameters, long numbers and long quoted text", () => {
  assert.equal(
    scrubText("ENOENT: no such file or directory, open '/Users/anna/Mandanten/Müller GmbH/Klage.docx'"),
    "ENOENT: no such file or directory, open '<path>'",
  );
  assert.equal(scrubText("EPERM: operation not permitted, unlink 'C:\\Users\\anna\\Akten\\Vertrag.docx'"), "EPERM: operation not permitted, unlink '<path>'");
  assert.equal(scrubText("cannot read \\\\fileserver\\akten\\2026\\brief.pdf"), "cannot read <path>");
  // Unquoted paths with spaces must not leak the rest of a folder name.
  assert.equal(scrubText("open /Users/anna/Mandanten/Müller GmbH/Klage.docx failed"), "open <path> failed");
  assert.equal(scrubText("copy C:\\Akten\\Kanzlei Müller und Partner\\Brief.docx done"), "copy <path> done");
  assert.equal(scrubText("failed to load file:///Users/anna/x.pdf"), "failed to load <path>");
  assert.equal(scrubText("mail to anna.schmidt@kanzlei-mueller.de failed"), "mail to <email> failed");
  assert.equal(scrubText("GET https://api.example.com/v1/search?q=Mandant+M%C3%BCller failed"), "GET https://api.example.com/v1/search?<params> failed");
  assert.equal(scrubText("invoice 4711123456789 rejected"), "invoice <number> rejected");
  assert.equal(
    scrubText(`prompt was "Bitte fasse die Klageschrift gegen die Müller GmbH zusammen"`),
    `prompt was "<text>"`,
  );
});

test("scrubText keeps the code-level meaning of engine messages", () => {
  assert.equal(scrubText("Cannot read properties of undefined (reading 'citations')"), "Cannot read properties of undefined (reading 'citations')");
  assert.equal(scrubText("Request failed with status 503"), "Request failed with status 503");
});

test("scrubText caps very long messages", () => {
  const long = "x ".repeat(600);
  assert.ok(scrubText(long).length <= 501);
});

test("scrubEvent removes identity, variables and paths outside the app", () => {
  const event = {
    server_name: "Annas-MacBook-Pro",
    user: { ip_address: "203.0.113.9" },
    request: { data: "secret" },
    contexts: { device: { name: "Annas MacBook", arch: "arm64" } },
    message: "saving /Users/anna/Akten/brief.docx failed",
    exception: {
      values: [
        {
          type: "Error",
          value: "open '/home/anna/x.txt' failed",
          stacktrace: {
            frames: [
              { filename: "app:///electron/main.mjs", abs_path: "app:///electron/main.mjs", vars: { text: "Klageschrift" } },
              { filename: "/Users/anna/Library/Application Support/LegalWork/plugins/custom.js", vars: { a: 1 } },
              { filename: "C:\\Program Files\\LegalWork\\resources\\app.asar\\electron\\runtime.mjs" },
            ],
          },
        },
      ],
    },
    extra: { workspace: "/Users/anna/Akten" },
    breadcrumbs: [
      { category: "console", message: "Klageschrift gegen Müller" },
      { category: "electron", message: "app.ready" },
      { category: "http", data: { url: "https://api.example.com/v1/x?token=abc", method: "POST", status_code: 500, request_body: "secret" } },
    ],
  };
  const out = scrubEvent(event);
  assert.equal(out.server_name, undefined);
  assert.equal(out.user, undefined);
  assert.equal(out.request, undefined);
  assert.equal(out.contexts.device.name, undefined);
  assert.equal(out.contexts.device.arch, "arm64");
  assert.equal(out.message, "saving <path> failed");
  const [value] = out.exception.values;
  assert.equal(value.value, "open '<path>' failed");
  assert.equal(value.stacktrace.frames[0].filename, "app:///electron/main.mjs");
  assert.equal(value.stacktrace.frames[0].vars, undefined);
  assert.equal(value.stacktrace.frames[1].filename, "<path>/custom.js");
  assert.equal(value.stacktrace.frames[1].vars, undefined);
  assert.match(value.stacktrace.frames[2].filename, /app\.asar/);
  assert.equal(out.extra.workspace, "<path>");
  assert.deepEqual(out.breadcrumbs.map((crumb) => crumb.category), ["electron", "http"]);
  assert.equal(out.breadcrumbs[1].data.url, "https://api.example.com/v1/x");
  assert.equal(out.breadcrumbs[1].data.request_body, undefined);
  assert.equal(out.breadcrumbs[1].data.status_code, 500);
});

test("scrubBreadcrumb drops user-interaction and console breadcrumbs", () => {
  assert.equal(scrubBreadcrumb({ category: "ui.click", message: "button.save" }), null);
  assert.equal(scrubBreadcrumb({ category: "console", message: "x" }), null);
  assert.equal(scrubBreadcrumb({ category: "navigation", data: { from: "/a", to: "/b" } }), null);
  assert.equal(scrubBreadcrumb(null), null);
});

test("the consent gate sends only while reporting is allowed", async () => {
  const sent = [];
  const inner = { send: async (envelope) => { sent.push(envelope); return { statusCode: 200 }; }, flush: async () => true };
  let allowed = false;
  const transport = createConsentGatedTransport(inner, () => allowed);
  await transport.send("before consent");
  allowed = true;
  await transport.send("after consent");
  allowed = false;
  await transport.send("after withdrawal");
  assert.deepEqual(sent, ["after consent"]);
  assert.equal(await transport.flush(100), true);
});
