import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";

import appConfig from "./vite.config";

// An isolated review build: never included in the desktop or web app bundle.
export default mergeConfig(appConfig, defineConfig({
  build: {
    outDir: "dist-design-system",
    rollupOptions: {
      input: fileURLToPath(new URL("./design-system.html", import.meta.url)),
    },
  },
}));
