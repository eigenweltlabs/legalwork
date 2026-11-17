import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { CostUsage } from "@legalwork/types/session-cost";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><body></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CostRow } = await import("../../src/components/chat/cost-indicator");
const { setLocale } = await import("../../src/i18n");
setLocale("en");

function usage(name: string, cost: number, input: number): CostUsage {
  const amounts = [{ currency: "EUR", cost, knownCost: cost }] satisfies CostUsage["amounts"];
  const tokens = { input, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
  return { amounts, tokens, calls: 1, pendingCalls: 0, unpricedCalls: 0,
    models: [{ providerId: "eigenwelt", modelId: `synthetic-${input}`, modelName: name, amounts, tokens, calls: 1 }] };
}
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes(label));
  assert.ok(result, `Missing ${label}`); return result;
}
function panel(trigger: HTMLButtonElement) {
  const id = trigger.getAttribute("aria-controls"); assert.ok(id);
  const result = document.getElementById(id); assert.ok(result); return result;
}
async function click(element: HTMLButtonElement) { await act(async () => element.click()); }
function closed() {
  assert.equal(button("This answer").getAttribute("aria-expanded"), "false");
  assert.equal(button("This conversation").getAttribute("aria-expanded"), "false");
}

try {
  await act(async () => root.render(<CostRow usage={usage("Answer model", 0.03, 120)} conversation={usage("Conversation model", 0.09, 270)} busy={false} pending={false} failed={false} refresh={() => {}}><span>Synthetic response</span></CostRow>));
  const trigger = host.querySelector<HTMLButtonElement>("button[aria-label]"); assert.ok(trigger);
  await click(trigger); closed();
  const answer = button("This answer"), conversation = button("This conversation");
  await act(async () => answer.focus()); closed();
  await click(answer);
  assert.equal(document.activeElement, answer, "Focus stays on the opened row");
  const answerPanel = panel(answer);
  assert.ok(answer.parentElement?.contains(answerPanel), "Answer details belong to their own disclosure");
  assert.ok(answer.compareDocumentPosition(answerPanel) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(answerPanel.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING,
    "Answer details must appear before the conversation row");
  assert.equal(answerPanel.querySelector("dd")?.textContent, "120");
  assert.ok(answerPanel.textContent?.includes("Answer model"));
  assert.equal(answerPanel.textContent?.includes("Conversation model"), false);

  await act(async () => conversation.focus());
  assert.equal(answer.getAttribute("aria-expanded"), "true", "Focusing another row does not open it");
  await click(conversation);
  assert.equal(answer.getAttribute("aria-expanded"), "false", "Only one scope opens at a time");
  assert.equal(conversation.getAttribute("aria-expanded"), "true");
  const conversationPanel = panel(conversation);
  assert.ok(conversation.parentElement?.contains(conversationPanel));
  assert.ok(conversation.compareDocumentPosition(conversationPanel) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(conversationPanel.querySelector("dd")?.textContent, "270");
  assert.ok(conversationPanel.textContent?.includes("Conversation model"));
  assert.equal(conversationPanel.textContent?.includes("Answer model"), false);
  assert.equal(document.activeElement, conversation, "Switching details keeps focus on its trigger");

  await click(conversation); closed();
  await click(answer); await click(trigger); await click(trigger); closed();
  console.log("Cost disclosure flow passed");
} finally { await act(async () => root.unmount()); await window.happyDOM.close(); }
