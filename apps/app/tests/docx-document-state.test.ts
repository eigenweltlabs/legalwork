import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactDocumentKey,
  confirmDiscardDocuments,
  reconcileDocxSnapshot,
  registerUnsavedDocument,
  savedDocxSnapshot,
  type DocxSnapshot,
} from "../src/react-app/domains/session/artifacts/docx-document-state.ts";

const snapshot = (revision: number): DocxSnapshot => ({
  kind: "binary",
  data: new Uint8Array([revision]).buffer,
  contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  updatedAt: revision,
  revision,
});

describe("DOCX document lifetime", () => {
  test("an agent refresh retains a dirty draft and its original conflict baseline", () => {
    const loaded = snapshot(1);
    const changedOnDisk = snapshot(2);
    const retained = reconcileDocxSnapshot(loaded, changedOnDisk, true);
    assert.equal(retained, loaded);
    assert.equal(retained.updatedAt, 1);
    assert.deepEqual(new Uint8Array(retained.data), new Uint8Array([1]));
  });

  test("a clean document picks up externally changed content", () => {
    const latest = snapshot(2);
    assert.equal(reconcileDocxSnapshot(snapshot(1), latest, false), latest);
    assert.equal(reconcileDocxSnapshot(null, latest, false), latest);
  });

  test("a successful save advances conflict baseline without changing editor identity", () => {
    const loaded = snapshot(1);
    const editedBytes = new Uint8Array([3]).buffer;
    const saved = savedDocxSnapshot(loaded, editedBytes, 3);
    assert.equal(saved.revision, loaded.revision);
    assert.equal(saved.updatedAt, 3);
    assert.equal(saved.data, editedBytes);
    assert.equal(reconcileDocxSnapshot(saved, saved, false), saved);
    assert.equal(reconcileDocxSnapshot(saved, snapshot(3), false), saved);
    // A subsequent external revision must still be detected.
    const external = snapshot(4);
    assert.equal(reconcileDocxSnapshot(saved, external, false), external);
  });
});

describe("DOCX close protection", () => {
  test("only closing dirty documents prompts, and cancelling prevents close", () => {
    const key = artifactDocumentKey("workspace", "session", "contract.docx");
    let dirty = true;
    const unregister = registerUnsavedDocument(key, "contract.docx", () => dirty);
    const prompts: string[] = [];
    const cancel = (message: string) => { prompts.push(message); return false; };
    try {
      assert.equal(confirmDiscardDocuments("another-document", cancel), true);
      assert.equal(confirmDiscardDocuments(key, cancel), false);
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0].includes("contract.docx"));
      dirty = false;
      assert.equal(confirmDiscardDocuments(key, cancel), true);
      assert.equal(prompts.length, 1);
    } finally {
      unregister();
    }
    assert.equal(confirmDiscardDocuments(key, cancel), true);
  });

  test("closing the pane checks every registered dirty document", () => {
    const unregister = registerUnsavedDocument("inactive", "Schedule.docx", () => true);
    try {
      assert.equal(confirmDiscardDocuments(undefined, () => false), false);
      assert.equal(confirmDiscardDocuments(undefined, () => true), true);
    } finally {
      unregister();
    }
  });
});
