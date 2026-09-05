import { StrictMode, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import {
  ArrowUp, ArrowUpRight, Check, ChevronDown, Copy, Ellipsis, FileText,
  Layers, LoaderCircle, MessageSquare, Paperclip, Plus, RotateCcw, Search,
  Settings2, SlidersHorizontal, Sparkles, Trash2, Workflow,
} from "lucide-react";

import { ArtifactIcon } from "@/components/chat/artifact-icon";
import { WelcomeHeading, WelcomeSurface } from "@/components/chat/session-welcome";
import { TaskSuggestionCards } from "@/components/chat/task-suggestions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ArtifactType } from "@/lib/artifacts";
import { FolderIcon } from "./folder-icon";
import { PanelEmptyState, PanelHeader } from "./panel-chrome";
import { IconTile, SectionHeading, Surface } from "./surface";
import { TextInput } from "./text-input";
import { WorkspaceIcon } from "./workspace-icon";
import "@/app/index.css";
import "./preview.css";

const buttonVariants: { value: ComponentProps<typeof Button>["variant"]; label: string }[] = [
  { value: "default", label: "Primary" },
  { value: "outline", label: "Outline" },
  { value: "secondary", label: "Secondary" },
  { value: "ghost", label: "Ghost" },
  { value: "destructive", label: "Destructive" },
  { value: "link", label: "Link" },
];

const fileTypes: ArtifactType[] = ["document", "pdf", "sheet", "slides", "markdown", "image", "website", "html"];

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function PreviewSection({ id, title, description, children }: {
  id: string; title: string; description: string; children: ReactNode;
}) {
  return (
    <section id={id} className="space-y-6 border-t border-border py-10 sm:py-12">
      <SectionHeading title={title} description={description} />
      {children}
    </section>
  );
}

function ComponentComposition() {
  const [activeNav, setActiveNav] = useState("New conversation");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return (
    <Surface className="design-preview-frame overflow-hidden">
      <SidebarProvider className="block min-h-0 border-r border-border bg-sidebar p-2">
        <SidebarHeader className="mb-3 flex-row items-center gap-2 px-2 py-3">
          <WorkspaceIcon workspaceId="preview" sizeClass="size-6" />
          <span className="text-sm font-medium">My workspace</span>
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground" />
        </SidebarHeader>
        <SidebarMenu>
          {[
            { title: "New conversation", icon: Plus },
            { title: "Search", icon: Search },
            { title: "Skills", icon: Sparkles },
            { title: "Automations", icon: Workflow },
          ].map(({ title, icon: Icon }) => (
            <SidebarMenuItem key={title}>
              <SidebarMenuButton isActive={activeNav === title} onClick={() => setActiveNav(title)}>
                <Icon /><span>{title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <SidebarGroup className="mt-5 px-0">
          <SidebarGroupLabel>Recent work</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {["Review supplier agreement", "Prepare board summary", "Compare the latest drafts"].map((title) => (
                <SidebarMenuItem key={title}>
                  <SidebarMenuButton isActive={activeNav === title} onClick={() => setActiveNav(title)}>
                    <MessageSquare /><span>{title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarProvider>
      <div className="flex min-w-0 flex-col items-center justify-center gap-7 px-5 py-12 sm:px-8">
        <WelcomeHeading />
        <Surface variant="glass" className="w-full max-w-lg p-3">
          <Textarea
            aria-label="Specimen conversation message"
            value={message}
            onChange={(event) => { setMessage(event.target.value); setSubmitted(false); }}
            placeholder="What would you like to work on?"
            className="min-h-20 border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
          />
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Attachments specimen" />}><Paperclip /></TooltipTrigger>
                <TooltipContent>Attachment control</TooltipContent>
              </Tooltip>
              <span className="text-xs text-muted-foreground">Your workspace</span>
            </div>
            <Button size="icon-sm" aria-label="Send specimen message" disabled={!message.trim()} onClick={() => setSubmitted(true)}>
              {submitted ? <Check /> : <ArrowUp />}
            </Button>
          </div>
        </Surface>
        <p className="text-center text-xs text-muted-foreground" role="status">
          {submitted ? "Preview only. No message was sent." : "Component composition · sample content"}
        </p>
      </div>
      <aside className="border-l border-border bg-muted/20">
        <PanelHeader title="Files" meta="3"><Button size="icon-xs" variant="ghost" aria-label="File options specimen"><Ellipsis /></Button></PanelHeader>
        <div className="space-y-1 p-3">
          <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium"><FolderIcon open />Matter documents</div>
          {["Supplier agreement", "Review summary", "Key terms"].map((name) => (
            <div key={name} className="ml-3 flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-muted-foreground">
              <ArtifactIcon type="document" className="size-4" /><span className="truncate">{name}</span>
            </div>
          ))}
        </div>
      </aside>
    </Surface>
  );
}

function DesignSystemPreview() {
  const [notice, setNotice] = useState("Use Tab to inspect keyboard focus. Hover and press controls to inspect their real states.");
  const [revision, setRevision] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [showProviderPrompt, setShowProviderPrompt] = useState(false);
  const [suggestion, setSuggestion] = useState("");

  useEffect(() => {
    document.documentElement.dataset.previewReducedMotion = String(reduceMotion);
    return () => { delete document.documentElement.dataset.previewReducedMotion; };
  }, [reduceMotion]);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
    <TooltipProvider delay={200}>
      <main className="design-preview">
        <header className="sticky top-0 z-20 border-b border-border bg-[var(--lw-glass)] backdrop-blur-[var(--lw-glass-blur)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-5 py-4 sm:px-8">
            <a href="#" className="flex items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
              <img src="/legalwork-mark.svg" alt="" className="size-6" />
              <span className="text-sm font-medium tracking-[-0.02em]">LegalWork <span className="ml-1 font-normal text-muted-foreground">/ Design system</span></span>
            </a>
            <Badge variant="outline">Live components</Badge>
          </div>
        </header>
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="pb-10 pt-12 sm:pb-12 sm:pt-16">
            <p className="mb-4 text-xs font-medium text-muted-foreground">WHITE · GLASS · GRAPHITE</p>
            <h1 className="max-w-3xl text-4xl font-medium leading-[1.08] tracking-[-0.05em] sm:text-5xl">Quiet surfaces.<br />Confident details.</h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">The shared visual language for LegalWork. Every specimen below uses the same tokens and components as the application.</p>
            <nav aria-label="Design system sections" className="mt-7 flex flex-wrap gap-2">
              {["Foundations", "Controls", "Assets", "Overlays", "Composition", "Motion"].map((title) => (
                <a key={title} href={`#${title.toLowerCase()}`} className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{title}</a>
              ))}
            </nav>
          </div>

          <PreviewSection id="foundations" title="01 / Foundations" description="Hierarchy comes from spacing, type, and carefully bounded surfaces.">
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { label: "Canvas", token: "--lw-canvas" },
                { label: "Sidebar", token: "--lw-sidebar" },
                { label: "Glass", token: "--lw-glass" },
                { label: "Primary text", token: "--lw-text-primary" },
                { label: "Secondary text", token: "--lw-text-secondary" },
                { label: "Border", token: "--lw-border" },
              ].map(({ label, token }) => (
                <Surface key={token} className="overflow-hidden">
                  <div className="h-16 border-b border-border" style={{ background: `var(${token})` }} />
                  <div className="space-y-1 px-4 py-3"><p className="text-sm font-medium">{label}</p><code className="text-xs text-muted-foreground">{token}</code></div>
                </Surface>
              ))}
            </div>
            <div className="grid gap-6 pt-3 md:grid-cols-2">
              <Surface className="space-y-5 p-6">
                <SectionHeading title="Clear thinking starts here" size="page" />
                <SectionHeading title="Everything in its place" description="Body text uses generous line height and a measured line length. Secondary text stays readable." />
                <SectionHeading title="RECENT WORK" size="sidebar" description="Small labels support navigation." />
                <p className="font-mono text-xs text-muted-foreground">agreement-v3.docx · 124 KB</p>
              </Surface>
              <div className="grid gap-3">
                <Surface className="p-4"><SectionHeading title="Default surface" description="Documents, cards, and content." /></Surface>
                <Surface variant="glass" className="p-4"><SectionHeading title="Glass surface" description="Chrome and transient layers. Keep reading surfaces opaque." /></Surface>
                <Surface variant="inset" className="p-4"><SectionHeading title="Inset surface" description="Groups, tracks, and quieter supporting content." /></Surface>
              </div>
            </div>
          </PreviewSection>

          <PreviewSection id="controls" title="02 / Controls" description="Consistent proportions, explicit feedback, and visible keyboard focus.">
            <Surface className="overflow-x-auto p-5 sm:p-6">
              <div className="grid min-w-[600px] grid-cols-[100px_repeat(3,minmax(0,1fr))] items-center gap-4">
                <span /><p className="text-xs text-muted-foreground">Rest / hover / press</p><p className="text-xs text-muted-foreground">With icon</p><p className="text-xs text-muted-foreground">Disabled</p>
                {buttonVariants.map(({ value, label }) => (
                  <div key={value} className="contents">
                    <span className="text-xs font-medium text-muted-foreground">{label}</span>
                    <Button variant={value} className="w-fit" onClick={() => setNotice(`${label} button activated.`)}>Continue</Button>
                    <Button variant={value} className="w-fit" onClick={() => setNotice(`${label} icon button activated.`)}><Plus />New project</Button>
                    <Button variant={value} className="w-fit" disabled>Continue</Button>
                  </div>
                ))}
              </div>
              <p className="mt-6 text-xs text-muted-foreground" role="status">{notice}</p>
            </Surface>
            <div className="grid gap-6 md:grid-cols-2">
              <Surface className="space-y-5 p-6">
                <TextInput label="Workspace name" placeholder="e.g. Commercial matters" hint="Production TextInput wraps the shared field treatment." />
                <label className="block space-y-2 text-xs font-medium">Invalid input<Input aria-invalid="true" aria-describedby="preview-input-error" defaultValue="" placeholder="Name required" /><span id="preview-input-error" className="block text-destructive">Enter a workspace name.</span></label>
                <label className="block space-y-2 text-xs font-medium">Disabled input<Input disabled value="Managed by your organization" /></label>
                <label className="block space-y-2 text-xs font-medium">Description<Textarea placeholder="Add context for your team…" /></label>
              </Surface>
              <Surface className="space-y-6 p-6">
                <Specimen label="Sizes"><div className="flex flex-wrap items-center gap-3"><Button size="xs">Compact</Button><Button size="sm">Small</Button><Button>Default</Button><Button size="lg">Large</Button></div></Specimen>
                <Specimen label="Busy and icon-only"><div className="flex items-center gap-3"><Button disabled aria-busy="true"><LoaderCircle className="motion-safe:animate-spin" />Saving</Button><Button variant="outline" size="icon" aria-label="Search specimen"><Search /></Button><Button variant="ghost" size="icon" aria-label="Settings specimen"><Settings2 /></Button></div></Specimen>
                <div className="flex flex-wrap gap-6"><label className="flex items-center gap-3 text-sm"><Checkbox defaultChecked />Include documents</label><label className="flex items-center gap-3 text-sm"><Switch defaultChecked />Notifications</label></div>
                <div className="flex flex-wrap gap-2"><Badge>Selected</Badge><Badge variant="secondary">Draft</Badge><Badge variant="outline"><Check />Connected</Badge><Badge variant="destructive">Needs attention</Badge></div>
                <Tabs defaultValue="overview"><TabsList aria-label="Sample section"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger><TabsTrigger value="disabled" disabled>Unavailable</TabsTrigger></TabsList><TabsContent value="overview" className="pt-2 text-muted-foreground">A clear active tab, with quiet neighboring sections.</TabsContent><TabsContent value="activity" className="pt-2 text-muted-foreground">Keyboard navigation and active state come from Base UI.</TabsContent></Tabs>
              </Surface>
            </div>
          </PreviewSection>

          <PreviewSection id="assets" title="03 / Assets and cards" description="Light-blue folders and subtly tinted file icons stay crisp at compact sidebar sizes.">
            <Surface className="space-y-7 p-6">
              <div className="grid gap-6 sm:grid-cols-3">
                <Specimen label="Folder / closed"><div className="flex items-end gap-5"><FolderIcon className="size-4" /><FolderIcon className="size-6" /><FolderIcon className="size-10" /><FolderIcon className="size-14" /></div></Specimen>
                <Specimen label="Folder / open"><div className="flex items-end gap-5"><FolderIcon open className="size-4" /><FolderIcon open className="size-6" /><FolderIcon open className="size-10" /><FolderIcon open className="size-14" /></div></Specimen>
                <Specimen label="Icon containers"><div className="flex items-end gap-3"><IconTile size="sm"><Search /></IconTile><IconTile variant="inset"><Layers /></IconTile><IconTile size="lg" variant="glass"><Workflow /></IconTile></div></Specimen>
              </div>
              <div className="grid grid-cols-4 gap-5 border-t border-border pt-6 sm:grid-cols-8">
                {fileTypes.map((type) => <Specimen key={type} label={type}><ArtifactIcon type={type} className="size-9" /></Specimen>)}
              </div>
            </Surface>
            <div className="grid gap-4 sm:grid-cols-3">
              <Card><CardHeader><IconTile className="mb-3"><FileText /></IconTile><CardTitle>Review documents</CardTitle><CardDescription>Careful detail in a clear, reusable card.</CardDescription></CardHeader><CardContent><Button variant="outline" size="sm">Open review<ArrowUpRight /></Button></CardContent></Card>
              <Card variant="glass"><CardHeader><IconTile className="mb-3" variant="glass"><Workflow /></IconTile><CardTitle>Build a workflow</CardTitle><CardDescription>A glass variant for supporting surfaces.</CardDescription></CardHeader><CardContent><Button variant="outline" size="sm">Explore<ArrowUpRight /></Button></CardContent></Card>
              <Card variant="outline"><CardHeader><div className="mb-3 flex size-10 items-center"><Skeleton className="size-10 rounded-xl" /></div><CardTitle>Loading state</CardTitle><CardDescription>Keep the content geometry while it loads.</CardDescription></CardHeader><CardContent className="space-y-2"><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /></CardContent></Card>
            </div>
            <Surface className="overflow-hidden"><PanelHeader title="Workspace files" icon={<FolderIcon />} /><PanelEmptyState icon={<FolderIcon open />} title="A place for your documents" description="Add files to give your workspace useful context." /></Surface>
          </PreviewSection>

          <PreviewSection id="overlays" title="04 / Menus and dialogs" description="Transient layers have restrained depth and share the same corner and motion language.">
            <Surface className="flex flex-wrap items-center gap-4 p-6">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>Document actions<ChevronDown /></DropdownMenuTrigger>
                <DropdownMenuContent className="w-60">
                  <DropdownMenuGroup><DropdownMenuLabel>Agreement.docx</DropdownMenuLabel><DropdownMenuItem onClick={() => setNotice("Rename selected in menu specimen.")}><FileText />Rename</DropdownMenuItem><DropdownMenuItem onClick={() => setNotice("Duplicate selected in menu specimen.")}><Copy />Duplicate</DropdownMenuItem><DropdownMenuItem disabled><ArrowUpRight />Share with team</DropdownMenuItem></DropdownMenuGroup>
                  <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => setNotice("Delete selected in menu specimen. No file was changed.")}><Trash2 />Delete file</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Dialog>
                <DialogTrigger render={<Button variant="outline" />}>Open dialog</DialogTrigger>
                <DialogContent><DialogHeader><DialogTitle>A place for focused decisions</DialogTitle><DialogDescription>Dialogs keep the task clear, with readable content and a predictable action area.</DialogDescription></DialogHeader><TextInput label="Project name" defaultValue="Commercial matters" /><DialogFooter><DialogClose render={<Button variant="outline" />}>Cancel</DialogClose><DialogClose render={<Button />}>Save changes</DialogClose></DialogFooter></DialogContent>
              </Dialog>
              <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Filter preview" />}><SlidersHorizontal /></TooltipTrigger><TooltipContent>Filter documents</TooltipContent></Tooltip>
              <span className="text-xs text-muted-foreground">Try keyboard navigation, Escape, and focus return.</span>
            </Surface>
          </PreviewSection>

          <PreviewSection id="composition" title="05 / In context" description="A compact composition of production sidebar, field, surface, and asset components. Sample content stays local.">
            <ComponentComposition />
          </PreviewSection>

          <PreviewSection id="motion" title="06 / Motion" description="Animate orientation and feedback. Never make users wait for the interface.">
            <Surface className="space-y-8 p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <label className="flex items-center gap-3 text-sm"><Switch checked={reduceMotion} onCheckedChange={setReduceMotion} />Simulate reduced motion</label>
                <label className="flex items-center gap-3 text-sm"><Switch checked={showProviderPrompt} onCheckedChange={setShowProviderPrompt} />Show provider prompt</label>
                <Button variant="outline" onClick={() => setRevision((value) => value + 1)}><RotateCcw />Replay</Button>
              </div>
              <WelcomeSurface replayKey={`welcome-${revision}`}>
                <TaskSuggestionCards providerConnectedCount={showProviderPrompt ? 0 : 1} onConnect={() => setShowProviderPrompt(false)} onSelect={setSuggestion} />
              </WelcomeSurface>
              {suggestion ? <label className="block space-y-2 text-xs font-medium">Selected suggestion · preview only<Textarea readOnly value={suggestion} /></label> : null}
              <div key={`surface-${revision}`} className="lw-enter flex items-center gap-3"><IconTile variant="glass"><Layers /></IconTile><p className="text-sm text-muted-foreground">Shared surface entrance · the system preference also applies.</p></div>
            </Surface>
          </PreviewSection>
          <footer className="border-t border-border py-7 text-xs leading-relaxed text-muted-foreground">Live reference · App primitives in components/ui · Product patterns in react-app/design-system · Tokens in packages/ui/src/styles/tokens.css</footer>
        </div>
      </main>
    </TooltipProvider>
    </MotionConfig>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Design system preview root not found");
createRoot(root).render(<StrictMode><DesignSystemPreview /></StrictMode>);
