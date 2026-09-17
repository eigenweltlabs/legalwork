import { describe, expect, test } from "bun:test";

import {
  TASK_ATTACHMENT_DRAG_TYPE,
  hasTaskAttachmentDrag,
  readTaskAttachmentDrag,
  writeTaskAttachmentDrag,
} from "../src/app/lib/task-attachment-drag";

function dataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    effectAllowed: "none",
    get types() {
      return Array.from(store.keys());
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
  } as unknown as DataTransfer;
}

const attachment = {
  id: "attachment-1",
  filename: "complaint.pdf",
  contentType: "application/pdf",
  size: 1234,
  cached: true,
};

describe("task-attachment-drag", () => {
  test("round-trips the task and attachment address", () => {
    const transfer = dataTransfer();
    writeTaskAttachmentDrag(transfer, "task-1", attachment);

    expect(hasTaskAttachmentDrag(transfer)).toBe(true);
    expect(readTaskAttachmentDrag(transfer)).toEqual({
      taskId: "task-1",
      attachmentId: "attachment-1",
      filename: "complaint.pdf",
      contentType: "application/pdf",
    });
    expect(transfer.getData("text/plain")).toBe("complaint.pdf");
  });

  test("rejects missing and malformed attachment payloads", () => {
    const empty = dataTransfer();
    expect(hasTaskAttachmentDrag(empty)).toBe(false);
    expect(readTaskAttachmentDrag(empty)).toBeNull();

    for (const payload of ['{"taskId":"task-1"}', '{"taskId":"","attachmentId":"a","filename":"a","contentType":""}', "not json"]) {
      const transfer = dataTransfer();
      transfer.setData(TASK_ATTACHMENT_DRAG_TYPE, payload);
      expect(readTaskAttachmentDrag(transfer)).toBeNull();
    }
  });
});
