import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { app } from "electron";

const require = createRequire(import.meta.url);

app.whenReady().then(async () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
    db.prepare("INSERT INTO smoke VALUES (?)").run("native-sqlite-ok");
    assert.equal(db.prepare("SELECT value FROM smoke").get().value, "native-sqlite-ok");
  } finally {
    db.close();
  }
  console.log(`PASS: SQLite opens and queries under Electron ${process.versions.electron}`);

  const pty = require("node-pty");
  await new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const terminal = pty.spawn(windows ? (process.env.ComSpec || "cmd.exe") : process.execPath,
      windows ? ["/d", "/s", "/c", "echo native-pty-ok & pause >nul"] : ["-e", "process.stdout.write('native-pty-ok')"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let output = "";
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error("Native PTY did not exit within 10 seconds"));
    }, 10_000);
    let released = false;
    terminal.onData((data) => {
      output += data;
      // Electron.exe is a GUI-subsystem executable on Windows, so test the
      // actual console shell there and wait for output before asking it to exit.
      if (windows && !released && output.includes("native-pty-ok")) {
        released = true;
        terminal.write("\r");
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      try {
        assert.equal(exitCode, 0);
        assert.match(output, /native-pty-ok/);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  console.log("PASS: native PTY starts a process and receives its output");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
