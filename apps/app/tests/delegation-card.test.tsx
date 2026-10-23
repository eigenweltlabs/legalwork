import { expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { DelegationCard, parseDelegationCard } from "../src/components/chat/delegation-card";

const delegation = { workspaceId: "matter", sessionId: "review", projectName: "Matter project", title: "Review agreement", scope: "Review the indemnity clause only", status: "started" };

test("delegation cards preserve a recoverable chat even when delivery is unconfirmed", () => {
  expect(parseDelegationCard(JSON.stringify({ ok: true, delegation }))).toEqual(delegation);
  const uncertain = { ...delegation, status: "delivery-unconfirmed" };
  expect(parseDelegationCard({ ok: false, delegation: uncertain })).toEqual(uncertain);
  for (const output of ["{", null, { ok: false }, { delegation: { ...delegation, sessionId: "" } }, { delegation: { ...delegation, status: "completed" } }]) expect(parseDelegationCard(output)).toBeNull();
});

test("delegation cards show scope and navigation without claiming completion", () => {
  const html = renderToStaticMarkup(<MemoryRouter><DelegationCard part={{ type: "dynamic-tool", toolName: "legalwork_assistant_delegate", toolCallId: "delegate", state: "output-available", input: {}, output: { ok: true, delegation } }} /></MemoryRouter>);
  expect(html).toContain("Matter project");
  expect(html).toContain("Review the indemnity clause only");
  expect(html).toContain("Open chat");
  expect(html).toContain("Work started");
  expect(html).not.toContain("completed");
});
