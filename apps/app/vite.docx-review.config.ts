import { defineConfig, mergeConfig } from "vite";
import appConfig from "./vite.config";

// A fixed browser-test build avoids HMR interrupting long save/reopen checks.
// This entry is deliberately absent from the production app build.
export default mergeConfig(appConfig, defineConfig({
  base: "/docx-qa/",
  publicDir: false,
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: "docx-qa",
    emptyOutDir: true,
    rollupOptions: { input: { review: "docx-review.html" } },
  },
}));
