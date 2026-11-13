import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QueuedMessagesPanel,
  type QueuedMessagesPanelProps,
} from "../src/react-app/domains/session/modals/queued-messages-panel";
import type { QueuedComposerDraft } from "../src/react-app/domains/session/surface/composer-state-store";
import { t } from "../src/i18n";

const message: QueuedComposerDraft = {
  id: "follow-up",
  mode: "prompt",
  text: "Review the result",
  parts: [{ type: "text", text: "Review the result" }],
  attachments: [],
  canSteer: true,
  editor: { draft: "Review the result", attachments: [], mentions: {}, pasteParts: [] },
};

function renderQueue(overrides: Partial<QueuedMessagesPanelProps> = {}) {
  return renderToStaticMarkup(<QueuedMessagesPanel
    messages={[]}
    paused={false}
    disabled={false}
    onRemove={() => {}}
    onEdit={() => {}}
    onSteer={async () => {}}
    onReorder={() => {}}
    onCancelEdit={() => {}}
    onResume={() => {}}
    {...overrides}
  />);
}

test("an empty queue stays hidden after Stop pauses it", () => {
  expect(renderQueue()).toBe("");
  expect(renderQueue({ paused: true })).toBe("");
});

test("ordinary pending messages offer Steer even while paused", () => {
  const html = renderQueue({ messages: [message], paused: true });
  expect(html).toContain(t("composer.steer_queued"));
  const button = html.match(new RegExp(`<button[^>]*title="${t("composer.steer_queued_hint")}"[^>]*>`))?.[0];
  expect(button).toBeDefined();
  expect(button).not.toContain('disabled=""');
  expect(renderQueue({ messages: [{ ...message, mode: "shell", canSteer: false }] })).not.toContain(t("composer.steer_queued_hint"));
  expect(renderQueue({ messages: [{ ...message, command: { name: "review", arguments: "" }, canSteer: false }] })).not.toContain(t("composer.steer_queued_hint"));
});

test("Steer is disabled during editing, another window's lease and unresolved delivery", () => {
  for (const overrides of [
    { editingId: message.id }, { messages: [{ ...message, locked: true }] },
    ...(["sending", "accepted", "uncertain"] satisfies Array<QueuedComposerDraft["status"]>).map(status => ({ messages: [{ ...message, status }] })),
  ]) {
    const html = renderQueue({ messages: [message], ...overrides });
    const button = html.match(new RegExp(`<button[^>]*title="${t("composer.steer_queued_hint")}"[^>]*>`))?.[0];
    expect(button).toContain('disabled=""');
  }
});

test("paused follow-ups still show the message and Resume control", () => {
  const html = renderQueue({ messages: [message], paused: true });
  expect(html).toContain(message.text);
  expect(html).toContain(t("composer.queue_paused"));
  expect(html).toContain(t("composer.resume_queue"));
  expect(renderQueue({ messages: [message] })).not.toContain(t("composer.queue_paused"));
});

test("a missing edited entry still offers Cancel edit without an empty pause banner", () => {
  const html = renderQueue({ editingId: message.id, paused: true });
  expect(html).toContain(t("composer.cancel_queued_edit"));
  expect(html).not.toContain(t("composer.queue_paused"));
  expect(html).not.toContain(t("composer.resume_queue"));
});
