import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: { port: 4321, strictPort: true },
  resolve: {
    alias: {
      "@legalwork/ui/react": fileURLToPath(new URL("../src/react/index.ts", import.meta.url)),
    },
  },
});
