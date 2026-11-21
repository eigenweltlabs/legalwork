import assert from "node:assert/strict";
import test from "node:test";
import { runHud } from "./run-dictation-hud.mjs";

test("the HUD never starts Electron after a missing display or failed macOS probe", () => {
  for (const probe of [
    { status: 0, stdout: "false\n" },
    { status: 0, stdout: "" },
    { status: 1, stdout: "true\n" },
    { status: null, stdout: null },
  ]) {
    const commands = [];
    const exitCode = runHud("electron", ["--stopwatch"], "darwin", (command) => {
      commands.push(command);
      return probe;
    });
    assert.deepEqual(commands, ["/usr/bin/osascript"]);
    assert.equal(exitCode, 1);
  }
});

test("a confirmed macOS display launches the selected fixture and propagates its exit status", () => {
  const commands = [];
  const exitCode = runHud("electron", ["--stopwatch"], "darwin", (command, args) => {
    commands.push(command);
    if (command === "/usr/bin/osascript") return { status: 0, stdout: "true\n" };
    assert.match(args[0], /dictation-hud-regression\.mjs$/);
    assert.deepEqual(args.slice(1), ["--stopwatch"]);
    return { status: 3 };
  });
  assert.deepEqual(commands, ["/usr/bin/osascript", "electron"]);
  assert.equal(exitCode, 3);
});
