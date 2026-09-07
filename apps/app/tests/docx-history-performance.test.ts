import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useRef } from "react";
import { renderToString } from "react-dom/server";
import { createDocumentWithText } from "@eigenpal/docx-editor-core";
import { useDocumentHistory } from "@eigenpal/docx-editor-react/hooks";

function documentWithSerializationCounter(text: string, onSerialize: () => void) {
  const document = createDocumentWithText(text);
  return {
    ...document,
    package: {
      ...document.package,
      document: new Proxy(document.package.document, {
        get(target, property, receiver) {
          if (property === "toJSON") onSerialize();
          return Reflect.get(target, property, receiver);
        },
      }),
    },
  };
}

test("known ProseMirror changes reach history without serializing either document", () => {
  let serializations = 0;
  const onSerialize = () => { serializations += 1; };
  const original = documentWithSerializationCounter("Original clause", onSerialize);
  const edited = documentWithSerializationCounter("Edited clause", onSerialize);

  function Editor() {
    const history = useDocumentHistory(original, { enableKeyboardShortcuts: false });
    if (history.state === original) history.push(edited, undefined, true);
    else {
      assert.equal(history.state, edited);
      assert.equal(history.undoCount, 1);
      assert.equal(history.getUndoStack()[0].state, original);
    }
    return createElement("span", null, history.state === edited ? "edited" : "original");
  }

  assert.equal(renderToString(createElement(Editor)), "<span>edited</span>");
  assert.equal(serializations, 0);
});

test("equivalent external documents remain no-ops in history", () => {
  let serializations = 0;
  const onSerialize = () => { serializations += 1; };
  const original = documentWithSerializationCounter("Unchanged clause", onSerialize);
  const equivalent = { ...original, package: { ...original.package, document: { ...original.package.document } } };

  function Editor() {
    const history = useDocumentHistory(original, { enableKeyboardShortcuts: false });
    const attempted = useRef(false);
    if (!attempted.current) {
      attempted.current = true;
      history.push(equivalent);
    }
    assert.equal(history.state, original);
    assert.equal(history.undoCount, 0);
    return null;
  }

  renderToString(createElement(Editor));
  assert.equal(serializations, 1);
});

test("external document changes still use comparison and retain undo history", () => {
  let serializations = 0;
  const onSerialize = () => { serializations += 1; };
  const original = documentWithSerializationCounter("Original clause", onSerialize);
  const edited = documentWithSerializationCounter("External edit", onSerialize);

  function Editor() {
    const history = useDocumentHistory(original, { enableKeyboardShortcuts: false });
    if (history.state === original) history.push(edited);
    else {
      assert.equal(history.undoCount, 1);
      assert.equal(history.getUndoStack()[0].state, original);
    }
    return createElement("span", null, history.state === edited ? "edited" : "original");
  }

  assert.equal(renderToString(createElement(Editor)), "<span>edited</span>");
  assert.equal(serializations, 2);
});
