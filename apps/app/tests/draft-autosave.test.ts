import { expect, test } from "bun:test";
import { EmailDraftSchema } from "@legalwork/types/email-draft";
import { rebaseDraft } from "../src/components/chat/draft-autosave";

const base = EmailDraftSchema.parse({
  id: "b26d21f3-85ad-4c9f-a6ec-5249b2da280a", workspaceId: "project", revision: "e24143f1-b8b9-4a44-a497-8a3f2b3772b7", path: ".legalwork/email-drafts/draft.eml", updatedAt: 1,
  to: "client@example.com", subject: "Review", body: "Hi,\n\nThanks for discussing this with the team.",
});
const assistant = { ...base, revision: "08745cc6-4e59-4d81-953b-19d8ec595ee5", updatedAt: 2 };

test("user edits land on the assistant's newer version when they touched different fields", () => {
  const local = { ...base, body: "Hi,\n\nThanks for discussing this with the team!" };
  const latest = { ...assistant, subject: "Re: Review" };
  const { draft, overlap } = rebaseDraft(local, base, latest);
  expect(draft).toEqual({ ...latest, body: local.body });
  expect(overlap).toEqual([]);
});

test("the user's text wins where both changed the same field, and the clash is reported", () => {
  const local = { ...base, body: "Thanks! Our whole US infrastructure runs on it, and Gemini stays.", html: "" };
  const latest = { ...assistant, body: "Thanks. Our whole US infrastructure runs on it. Gemini stays." };
  const { draft, overlap } = rebaseDraft(local, base, latest);
  expect(draft.body).toBe(local.body);
  expect(overlap).toEqual(["body"]);
});

test("rebasing keeps the server's revision and metadata, and compares lists by value", () => {
  const attachments = [{ path: ".legalwork/email-drafts/attachments/a/brief.pdf", name: "brief.pdf", contentType: "application/pdf" }];
  const stale = { ...base, revision: "11111111-1111-4111-8111-111111111111", attachments: attachments.map(item => ({ ...item })) };
  const { draft, overlap } = rebaseDraft(stale, { ...base, attachments }, { ...assistant, attachments });
  expect(draft.revision).toBe(assistant.revision);
  expect(draft.updatedAt).toBe(assistant.updatedAt);
  expect(draft.attachments).toBe(attachments);
  expect(overlap).toEqual([]);
});
