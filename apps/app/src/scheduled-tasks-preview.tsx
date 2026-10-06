// Development only. Real production components and HTTP API; isolated fixture engine.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Clock3, House, LayoutGrid } from "lucide-react";
import { createLegalworkServerClient } from "@/app/lib/legalwork-server";
import { ScheduledTasksPage } from "@/react-app/domains/scheduled-tasks/scheduled-tasks-page";
import { initLocale, setLocale } from "@/i18n";
import { Toaster, toast } from "@/components/ui/sonner";
import "./app/index.css";

if (!import.meta.env.DEV) throw new Error("This fixture is only available in development.");
initLocale();
setLocale(new URLSearchParams(location.search).get("lang") === "de" ? "de" : "en");
const client = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:8798", token: "scheduled-preview" });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}>
  <div className="flex h-dvh flex-col bg-sidebar"><p className="border-b border-border px-4 py-2 text-center text-xs text-muted-foreground">Preview: isolated local schedules, simulated model responses</p>
    <div className="flex min-h-0 flex-1"><div aria-hidden className="flex w-14 shrink-0 flex-col items-center gap-5 py-6 text-muted-foreground"><House className="size-5" /><LayoutGrid className="size-5" /><span className="rounded-lg bg-sidebar-accent p-2 text-foreground"><Clock3 className="size-5" /></span></div>
      <ScheduledTasksPage client={client} projects={[{ id: "preview", name: "Northstar Legal" }]} onOpenSession={() => toast.info("The fixture simulates chat delivery. No model request was made.")} />
    </div>
  </div><Toaster />
</QueryClientProvider>);
