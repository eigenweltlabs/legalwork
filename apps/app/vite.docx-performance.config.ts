import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import appConfig from "./vite.config";

/** Standalone production benchmark; excluded from the application build. */
export default defineConfig({
  ...appConfig,
  build: {
    ...appConfig.build,
    outDir: "dist-docx-performance",
    rollupOptions: {
      input: fileURLToPath(new URL("./docx-performance.html", import.meta.url)),
    },
  },
});
