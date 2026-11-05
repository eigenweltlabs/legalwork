// Configure only this benchmark process, then execute the real application.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startBenchmarkFocus } from "./electron-focus.mjs";
const repository = process.env.LEGALWORK_BENCH_REPO;
if (!repository) throw new Error("The benchmark entry requires its source repository");
const require = createRequire(join(repository, "apps/desktop/package.json"));
const { app, BrowserWindow } = require("electron");
const root = process.env.LEGALWORK_BENCH_ROOT;
if (!root) throw new Error("The benchmark entry requires its isolated root");
app.setPath("home", join(root, "fixture-home"));
app.setPath("documents", join(root, "fixture-documents"));
await import(pathToFileURL(join(repository, "apps/desktop/electron/main.mjs")).href);
await startBenchmarkFocus({app,BrowserWindow,root,rendererOrigin:new URL(process.env.LEGALWORK_ELECTRON_START_URL).origin});
