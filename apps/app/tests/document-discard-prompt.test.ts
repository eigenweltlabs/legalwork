import { afterEach, expect, test } from "bun:test";
import { confirmDiscardDocuments, discardDocumentsThen, getDocumentDiscardPrompt, registerUnsavedDocument, resolveDocumentDiscardPrompt, waitForDocumentDiscardPrompt } from "../src/react-app/domains/session/artifacts/docx-document-state";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); resolveDocumentDiscardPrompt(false); });

test("cancel preserves the draft; consent resumes once and is scoped to that action", () => {
  let discarded = 0, performed = 0;
  cleanups.push(registerUnsavedDocument("prompt-test", "Draft.docx", () => true, () => discarded++));
  const run = () => discardDocumentsThen(() => performed++, "prompt-test");
  run();
  expect(getDocumentDiscardPrompt()?.names).toEqual(["Draft.docx"]);
  expect(performed).toBe(0); expect(discarded).toBe(0);
  resolveDocumentDiscardPrompt(false);
  expect(performed).toBe(0); expect(discarded).toBe(0);
  run(); resolveDocumentDiscardPrompt(true); resolveDocumentDiscardPrompt(true);
  expect(performed).toBe(1); expect(discarded).toBe(1);
  run(); expect(getDocumentDiscardPrompt()).not.toBeNull(); expect(performed).toBe(1);
});

test("a replacement registration needs fresh consent and cannot inherit a stale approval", () => {
  let oldDiscard = 0, newDiscard = 0, performed = 0;
  cleanups.push(registerUnsavedDocument("prompt-test", "Old.docx", () => true, () => oldDiscard++));
  discardDocumentsThen(() => performed++, "prompt-test");
  cleanups.push(registerUnsavedDocument("prompt-test", "Replacement.docx", () => true, () => newDiscard++));
  resolveDocumentDiscardPrompt(true);
  expect(performed).toBe(0); expect(oldDiscard).toBe(0); expect(newDiscard).toBe(0);
  expect(getDocumentDiscardPrompt()?.names).toEqual(["Replacement.docx"]);
  resolveDocumentDiscardPrompt(true);
  expect(performed).toBe(1); expect(newDiscard).toBe(1);
});

test("repeated guards share consent without discarding twice; automated checks cannot open a dialog", () => {
  let discarded = 0;
  cleanups.push(registerUnsavedDocument("prompt-test", "Draft.docx", () => true, () => discarded++));
  expect(confirmDiscardDocuments("prompt-test", () => false)).toBe(false);
  expect(getDocumentDiscardPrompt()).toBeNull();
  discardDocumentsThen(() => expect(confirmDiscardDocuments("prompt-test")).toBe(true), "prompt-test");
  resolveDocumentDiscardPrompt(true);
  expect(discarded).toBe(1);
});

test("an import batch waits through replacement consent and stops on cancellation", async () => {
  let performed = 0;
  cleanups.push(registerUnsavedDocument("prompt-test", "Old.docx", () => true));
  discardDocumentsThen(() => performed++, "prompt-test");
  const waiting = waitForDocumentDiscardPrompt();
  cleanups.push(registerUnsavedDocument("prompt-test", "New.docx", () => true));
  resolveDocumentDiscardPrompt(true);
  await Promise.resolve();
  expect(performed).toBe(0);
  expect(getDocumentDiscardPrompt()?.names).toEqual(["New.docx"]);
  resolveDocumentDiscardPrompt(false);
  expect(await waiting).toBe(false);
  expect(performed).toBe(0);
});

test("an import batch continues after consent has replayed the pending open", async () => {
  let performed = 0;
  cleanups.push(registerUnsavedDocument("prompt-test", "Draft.docx", () => true));
  discardDocumentsThen(() => performed++, "prompt-test");
  const waiting = waitForDocumentDiscardPrompt();
  expect(performed).toBe(0);
  resolveDocumentDiscardPrompt(true);
  expect(await waiting).toBe(true);
  expect(performed).toBe(1);
  expect(await waitForDocumentDiscardPrompt()).toBe(true);
});
