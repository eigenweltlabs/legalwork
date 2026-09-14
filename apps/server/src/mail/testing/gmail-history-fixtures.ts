/**
 * Synthetic wire responses, not a provider simulator or production persistence contract.
 * Fresh objects per call let independent transport/storage tests inject faults safely.
 * Gmail semantics checked 2026-09-09:
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
 * https://developers.google.com/workspace/gmail/api/guides/sync
 * Specific event fields may duplicate messages[]; IDs have gaps and are decimal strings.
 * A terminal page permits advancing historyId; history 404 requires full reconciliation.
 * Local retention, atomic replay and no submission replay below are Legalwork policy.
 */
type Message = { id: string; threadId: string };
type Metadata = Message & { labelIds: string[]; historyId: string; internalDate: string };
type History = {
  id: string; messages?: Message[];
  messagesAdded?: { message: Message }[];
  messagesDeleted?: { message: Message }[];
  labelsAdded?: { message: Message; labelIds: string[] }[];
  labelsRemoved?: { message: Message; labelIds: string[] }[];
};
type HistoryPage = { history: History[]; historyId: string; nextPageToken?: string };

export function createGmailHistoryFixtures() {
  const ids = { existing: "a100", deleted: "b200", laterAbsent: "c300", added: "d400", reconciled: "e500" };
  const cursor = { initial: "90071992547409930", first: "90071992547409937",
    second: "90071992547409951", terminal: "90071992547409980",
    empty: "90071992547409999", reconciliationAnchor: "90071992547410500" };
  const message = (id: string): Message => ({ id, threadId: `thread-${id}` });
  const metadata = (id: string, labelIds: string[], historyId = cursor.terminal): Metadata =>
    ({ ...message(id), labelIds, historyId, internalDate: "946684800000" }); // Old mail, outside recent window.
  const initial = [metadata(ids.existing, ["INBOX", "UNREAD", "Label_old"], cursor.initial),
    metadata(ids.deleted, ["INBOX"], cursor.initial), metadata(ids.laterAbsent, ["Label_keep"], cursor.initial)];
  const pages: HistoryPage[] = [
    { historyId: cursor.terminal, nextPageToken: "synthetic-history-page-2", history: [
      { id: cursor.first, messages: [message(ids.added), message(ids.existing), message(ids.added)],
        messagesAdded: [{ message: message(ids.added) }],
        labelsAdded: [{ message: message(ids.existing), labelIds: ["Label_new"] },
          { message: message(ids.added), labelIds: ["UNREAD"] }] },
    ] },
    { historyId: cursor.terminal, history: [
      { id: cursor.second, messages: [message(ids.existing), message(ids.deleted)],
        labelsRemoved: [{ message: message(ids.existing), labelIds: ["UNREAD", "INBOX", "Label_old"] }],
        messagesDeleted: [{ message: message(ids.deleted) }] },
    ] },
  ];
  return {
    ids, cursor, initial,
    // Distinct original references intentionally survive deletion and reconciliation.
    retainedOriginalMarkers: initial.map(item => ({ messageId: item.id, marker: `synthetic-original-${item.id}` })),
    localOnly: { draft: { id: "synthetic-local-draft", body: "Unsubmitted local draft" },
      actions: [{ replayKey: "synthetic-queued-mutation", state: "queued" },
        { replayKey: "synthetic-uncertain-submission", state: "uncertain" }] },
    incremental: {
      requests: [{ startHistoryId: cursor.initial },
        { startHistoryId: cursor.initial, pageToken: "synthetic-history-page-2" }],
      pages,
      // Fetching the new original may expose labels newer than its messagesAdded event.
      newMessageMetadata: metadata(ids.added, ["INBOX", "UNREAD"]),
      expected: { historyId: cursor.terminal, live: [metadata(ids.existing, ["Label_new"]),
        metadata(ids.laterAbsent, ["Label_keep"]), metadata(ids.added, ["INBOX", "UNREAD"])],
        remotelyDeleted: [ids.deleted], newRawMessageIds: [ids.added] },
      emptyPoll: { historyId: cursor.empty }, // history[] itself may be omitted.
    },
    reconciliation: {
      expiredHistory: { status: 404, body: { error: { code: 404, message: "Synthetic expired history" } } },
      anchorProfile: { emailAddress: "synthetic@example.invalid", historyId: cursor.reconciliationAnchor,
        messagesTotal: 3, threadsTotal: 3 },
      // Page size two includes all-mail enumeration (including SPAM/TRASH), not a recent query.
      listRequests: [{ maxResults: 2, includeSpamTrash: true },
        { maxResults: 2, includeSpamTrash: true, pageToken: "synthetic-reconcile-page-2" }],
      listPages: [{ messages: [message(ids.existing), message(ids.added)], nextPageToken: "synthetic-reconcile-page-2" },
        { messages: [message(ids.reconciled)] }],
      metadata: [metadata(ids.existing, ["Label_new", "STARRED"], cursor.reconciliationAnchor),
        metadata(ids.added, ["INBOX"], cursor.reconciliationAnchor),
        metadata(ids.reconciled, ["SPAM"], cursor.reconciliationAnchor)],
      expected: { remotelyDeleted: [ids.deleted, ids.laterAbsent], newRawMessageIds: [ids.reconciled],
        nextHistoryStart: cursor.reconciliationAnchor },
    },
    checkpoints: [
      "Crash before a page transaction commits: replay that exact request; no partial membership/cursor changes.",
      "Crash after page one commits: resume its continuation or safely replay from initial; never skip page two using its advertised terminal historyId.",
      "Replay a committed page: one provider message, one raw job and set-valued memberships; no duplicate effects from messages[].",
      "Crash on reconciliation page two: laterAbsent remains present until complete enumeration authorizes absence reconciliation.",
      "After terminal reconciliation, catch up from its pre-enumeration anchor; listing is not an atomic mailbox snapshot.",
      "At every boundary preserve all existing originals, the local draft and both action states; never redispatch uncertain submission.",
    ],
  };
}
