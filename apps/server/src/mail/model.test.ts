import { describe, expect, test } from "bun:test";
import {
  accountMessageKey, providerMessageKey, providerMessageLocatorSchema,
  mailDownloadProgressSchema, mailDownloadState, type MailDownloadProgress,
} from "./model.js";

const complete: MailDownloadProgress = {
  enumerationComplete: true, messagesDiscovered: 2, metadataStored: 2,
  rawMessagesStored: 2, bodiesStored: 2, attachmentsDiscovered: 3,
  attachmentsStored: 3, unavailableMessages: 0, unavailableAttachments: 0,
  outstandingJobs: 0, failedJobs: 0, excludedScopes: [],
};

describe("mail identity", () => {
  test("account, provider and provider message ID each preserve distinct copies", () => {
    const keys = [
      accountMessageKey("account-a", { provider: "gmail", messageId: "1" }),
      accountMessageKey("account-b", { provider: "gmail", messageId: "1" }),
      accountMessageKey("account-a", { provider: "graph", messageId: "1" }),
      accountMessageKey("account-a", { provider: "gmail", messageId: "2" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
  test("IMAP mailbox, UIDVALIDITY and UID are all identity components", () => {
    const base = { provider: "imap", mailboxId: "INBOX", uidValidity: 1, uid: 1 } satisfies Parameters<typeof providerMessageKey>[0];
    const keys = [base, { ...base, mailboxId: "Sent" }, { ...base, uidValidity: 2 }, { ...base, uid: 2 }].map(providerMessageKey);
    expect(new Set(keys).size).toBe(4);
    expect(providerMessageLocatorSchema.safeParse({ ...base, uid: 0 }).success).toBe(false);
    expect(providerMessageLocatorSchema.safeParse({ ...base, uidValidity: 0x100000000 }).success).toBe(false);
  });
  test("opaque punctuation and whitespace are preserved without delimiter collisions", () => {
    expect(accountMessageKey('a","b', { provider: "gmail", messageId: "c" }))
      .not.toBe(accountMessageKey("a", { provider: "gmail", messageId: 'b","c' }));
    expect(providerMessageKey({ provider: "graph", messageId: " opaque " }))
      .not.toBe(providerMessageKey({ provider: "graph", messageId: "opaque" }));
    expect(providerMessageLocatorSchema.safeParse({ provider: "gmail", messageId: "1", headerMessageId: "duplicate" }).success).toBe(false);
  });
});

describe("durable download completeness", () => {
  test("empty mailbox is complete only after enumeration", () => {
    const empty = { ...complete, messagesDiscovered: 0, metadataStored: 0, rawMessagesStored: 0, bodiesStored: 0, attachmentsDiscovered: 0, attachmentsStored: 0 };
    expect(mailDownloadState(empty)).toBe("complete");
    expect(mailDownloadState({ ...empty, enumerationComplete: false })).toBe("discovering");
  });
  test("header lists, missing bodies and never-opened attachments are incomplete", () => {
    expect(mailDownloadState(complete)).toBe("complete");
    expect(mailDownloadState({ ...complete, rawMessagesStored: 0, bodiesStored: 0, attachmentsStored: 0 })).toBe("downloading");
    expect(mailDownloadState({ ...complete, bodiesStored: 1 })).toBe("downloading");
    expect(mailDownloadState({ ...complete, attachmentsStored: 2 })).toBe("downloading");
    expect(mailDownloadState({ ...complete, outstandingJobs: 1 })).toBe("downloading");
  });
  test("unavailable, failed or excluded data never produces a whole-mailbox complete claim", () => {
    expect(mailDownloadState({ ...complete, failedJobs: 1 })).toBe("attention");
    expect(mailDownloadState({ ...complete, rawMessagesStored: 1, unavailableMessages: 1 })).toBe("attention");
    expect(mailDownloadState({ ...complete, attachmentsStored: 2, unavailableAttachments: 1 })).toBe("attention");
    expect(mailDownloadState({ ...complete, excludedScopes: [{ scopeId: "archive", reason: "provider-unavailable" }] })).toBe("attention");
  });
  test("inconsistent counters fail validation rather than producing misleading progress", () => {
    for (const snapshot of [
      { ...complete, metadataStored: 3 }, { ...complete, rawMessagesStored: 3 },
      { ...complete, bodiesStored: 3 }, { ...complete, attachmentsStored: 4 },
      { ...complete, unavailableMessages: 1 }, { ...complete, unavailableAttachments: 1 },
      { ...complete, outstandingJobs: -1 }, { ...complete, failedJobs: 0.5 },
      { ...complete, messagesDiscovered: Infinity },
    ]) expect(mailDownloadProgressSchema.safeParse(snapshot).success).toBe(false);
  });
});
