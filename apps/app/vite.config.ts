import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5173;
const allowedHosts = new Set<string>();
const envAllowedHosts = process.env.VITE_ALLOWED_HOSTS ?? "";

const addHost = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) return;
  allowedHosts.add(trimmed);
};

envAllowedHosts.split(",").forEach(addHost);
addHost(process.env.LEGALWORK_PUBLIC_HOST ?? null);
const hostname = os.hostname();
addHost(hostname);
const shortHostname = hostname.split(".")[0];
if (shortHostname && shortHostname !== hostname) {
  addHost(shortHostname);
}
const appRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const appPackagePath = resolve(appRoot, "package.json");
const desktopPackagePath = resolve(appRoot, "..", "desktop", "package.json");

function readPackageVersion(packagePath: string): string | null {
  if (!existsSync(packagePath)) return null;

  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  return parsed.version?.trim() || null;
}

const buildAppVersion =
  process.env.VITE_LEGALWORK_APP_VERSION?.trim() ||
  readPackageVersion(desktopPackagePath) ||
  readPackageVersion(appPackagePath) ||
  "0.0.0";

// Electron packaged builds load index.html via `file://`, so asset URLs
// must be relative. Gate on an env var the electron build script sets.
const isElectronPackagedBuild = process.env.LEGALWORK_ELECTRON_BUILD === "1";

export default defineConfig({
  base: isElectronPackagedBuild ? "./" : "/",
  define: {
    "import.meta.env.VITE_LEGALWORK_APP_VERSION": JSON.stringify(buildAppVersion),
  },
  plugins: [
    {
      name: "legalwork-dev-server-id",
      configureServer(server) {
        server.middlewares.use("/__legalwork_dev_server_id", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ appRoot }));
        });
      },
    },
    tailwindcss(),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { compilationMode: "annotation" }]],
      },
    }),
  ],
  server: {
    port: devPort,
    strictPort: true,
    ...(allowedHosts.size > 0 ? { allowedHosts: Array.from(allowedHosts) } : {}),
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        app: resolve(appRoot, "index.html"),
        overlay: resolve(appRoot, "overlay.html"),
        liveOverlay: resolve(appRoot, "live-overlay.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(appRoot, "src"),
    },
  },
});
