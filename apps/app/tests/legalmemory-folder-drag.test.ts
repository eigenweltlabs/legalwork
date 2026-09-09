import { describe, expect, test } from "bun:test";

import {
  LEGALMEMORY_FOLDER_DRAG_TYPE,
  hasLegalMemoryFileDrag,
  hasLegalMemoryFolderDrag,
  readLegalMemoryFileDrag,
  readLegalMemoryFolderDrag,
  writeLegalMemoryFileDrag,
  writeLegalMemoryFolderDrag,
} from "../src/app/lib/legalmemory-file";

/** The parts of DataTransfer a drag between two panes actually uses. */
function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  const transfer = {
    effectAllowed: "none",
    get types() {
      return [...store.keys()];
    },
    setData: (format: string, value: string) => void store.set(format, value),
    getData: (format: string) => store.get(format) ?? "",
  };
  return transfer as unknown as DataTransfer;
}

const folder = { name: "Pleadings", path: "matter/m-1/Pleadings", files: 4 };

describe("LegalMemory folder drag", () => {
  test("carries the folder from the drive row to the drop target", () => {
    const transfer = fakeDataTransfer();
    writeLegalMemoryFolderDrag(transfer, "src-1", folder);

    expect(hasLegalMemoryFolderDrag(transfer)).toBe(true);
    expect(readLegalMemoryFolderDrag(transfer)).toEqual({
      name: "Pleadings",
      path: "matter/m-1/Pleadings",
      source_id: "src-1",
    });
    expect(transfer.effectAllowed).toBe("copy");
  });

  test("a folder drag is never mistaken for a file drag, or the reverse", () => {
    const folderTransfer = fakeDataTransfer();
    writeLegalMemoryFolderDrag(folderTransfer, "src-1", folder);
    expect(hasLegalMemoryFileDrag(folderTransfer)).toBe(false);
    expect(readLegalMemoryFileDrag(folderTransfer)).toBeNull();

    const fileTransfer = fakeDataTransfer();
    writeLegalMemoryFileDrag(fileTransfer, {
      source_object_id: "obj-1",
      source_id: "src-1",
      name: "Answer.docx",
      path: "Pleadings/Answer.docx",
      mime_type: null,
      size_bytes: null,
      mtime: null,
      document_id: "doc-1",
    });
    expect(hasLegalMemoryFolderDrag(fileTransfer)).toBe(false);
    expect(readLegalMemoryFolderDrag(fileTransfer)).toBeNull();
  });

  test("ignores a payload that is not a folder we wrote", () => {
    const transfer = fakeDataTransfer();
    transfer.setData(LEGALMEMORY_FOLDER_DRAG_TYPE, "not json");
    expect(readLegalMemoryFolderDrag(transfer)).toBeNull();

    transfer.setData(LEGALMEMORY_FOLDER_DRAG_TYPE, JSON.stringify({ name: "Pleadings" }));
    expect(readLegalMemoryFolderDrag(transfer)).toBeNull();
  });
});
