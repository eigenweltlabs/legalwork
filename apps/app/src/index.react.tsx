/** @jsxImportSource react */
import * as React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getLegalWorkDeployment } from "./app/lib/legalwork-deployment";
import { bootstrapTheme } from "./app/theme";
import { isDesktopRuntime } from "./app/utils";
import { initLocale } from "./i18n";
import { getReactQueryClient } from "./react-app/infra/query-client";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "./react-app/kernel/platform";
import { AppProviders } from "./react-app/shell/providers";
import { AppErrorBoundary } from "./react-app/shell/app-error-boundary";
import { ErrorReportHost } from "./react-app/shell/error-report-dialog";
import { Toaster } from "@/components/ui/sonner";
import { initErrorAnalytics } from "./app/lib/app-error";
import { AppRoot } from "./react-app/shell/app-root";
import { startDeepLinkBridge } from "./react-app/shell/startup-deep-links";
import "./app/index.css";

initErrorAnalytics();
bootstrapTheme();
initLocale();
startDeepLinkBridge();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

root.dataset.legalworkDeployment = getLegalWorkDeployment();

const platform = createDefaultPlatform();
const queryClient = getReactQueryClient();
const Router = isDesktopRuntime() ? HashRouter : BrowserRouter;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorReportHost />
    <Toaster />
    <AppErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PlatformProvider value={platform}>
          <AppProviders>
            <Router>
              <AppRoot />
            </Router>
          </AppProviders>
        </PlatformProvider>
      </TooltipProvider>
    </QueryClientProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
