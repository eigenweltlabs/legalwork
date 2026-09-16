import { describe, expect, test } from "bun:test";

import {
  TASK_REFERENCE_SOURCE,
  taskReference,
  parseTaskLink,
  parseTaskReference,
  taskLinkUri,
} from "../src/react-app/domains/tasks/task-reference";

const TASK_ID = "6803168d-3938-445e-b079-8cf13a0099b6";

describe("intake task reference", () => {
  test("names the task by id and the tool that reads it", () => {
    expect(taskReference(TASK_ID)).toBe(`[task ${TASK_ID} via legalwork_task_get]`);
  });

  test("round-trips through the parser the chat badge uses", () => {
    expect(parseTaskReference(taskReference(TASK_ID))).toEqual({ taskId: TASK_ID });
  });

  test("is found inside a sentence, as the chat splits a message", () => {
    const message = `Load [skill workflow-assistant-nda] and follow its instructions for intake task ${taskReference(TASK_ID)}.`;
    const segments = message.split(new RegExp(`(${TASK_REFERENCE_SOURCE})`));
    expect(segments).toContain(taskReference(TASK_ID));
  });

  test("does not match ordinary bracketed prose", () => {
    expect(parseTaskReference("[task 42]")).toBeNull();
    expect(parseTaskReference("[skill workflow-assistant-nda]")).toBeNull();
  });
});

describe("task link (the chip an answer carries)", () => {
  test("round-trips the id through the href", () => {
    expect(taskLinkUri(TASK_ID)).toBe(`legalworktask://${TASK_ID}`);
    expect(parseTaskLink(taskLinkUri(TASK_ID))).toEqual({ taskId: TASK_ID });
    // Tolerates what the agent may write by hand.
    expect(parseTaskLink(`legalworktask:${TASK_ID}`)).toEqual({ taskId: TASK_ID });
    expect(parseTaskLink(` LEGALWORKTASK://${TASK_ID}/ `)).toEqual({ taskId: TASK_ID });
  });

  test("is not fooled by other schemes or paths", () => {
    expect(parseTaskLink("legalworkstorage://conn/path")).toBeNull();
    expect(parseTaskLink("legalworktask://")).toBeNull();
    expect(parseTaskLink(`legalworktask://${TASK_ID}/more`)).toBeNull();
    expect(parseTaskLink("drafts/Antwort.docx")).toBeNull();
  });
});
