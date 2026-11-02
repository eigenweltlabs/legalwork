import assert from "node:assert/strict";
import ts from "typescript";

/** Exercise every real quit listener, including registrations outside the main lifecycle block. */
export function beforeQuitRegistrations(source) {
  const parsed = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {string[]} */
  const registrations = [];
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression, target = call.expression, event = call.arguments[0];
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) &&
          target.expression.text === "app" && target.name.text === "on" &&
          event && ts.isStringLiteral(event) && event.text === "before-quit") registrations.push(node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(registrations.length, "Missing native before-quit listeners");
  return registrations.join("\n");
}
