// The isolated package copies only this file, electron-focus.mjs and
// private-write.mjs into its electron/ directory. No suite or assertion code.
import { app, BrowserWindow } from "electron";
import { startBenchmarkFocus } from "./electron-focus.mjs";
const root = process.env.LEGALWORK_BENCH_ROOT;
if (!root) throw new Error("Explicit isolated benchmark profile required");
await import("./main.mjs");
await startBenchmarkFocus({ app, BrowserWindow, root, rendererOrigin: "null" });
