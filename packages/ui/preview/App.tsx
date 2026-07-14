import { useState } from "react";
import {
  ArrowUp,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Github,
  Grid2x2,
  MessageSquarePlus,
  Mic,
  Moon,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Sun,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  AppIcon,
  Avatar,
  Badge,
  Button,
  Card,
  Composer,
  Divider,
  FileRow,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuItem,
  MenuSearch,
  MenuSeparator,
  Modal,
  ModelChip,
  Row,
  SearchInput,
  SegmentedControl,
  Select,
  Sidebar,
  SidebarGroup,
  SidebarItem,
  Slider,
  Switch,
  Tabs,
  Textarea,
  Tooltip,
  ToastProvider,
  useToast,
  Spinner,
  Dots,
  Skeleton,
  SkeletonText,
  Checkbox,
  Progress,
  Alert,
  FieldRow,
  ActionRow,
  StatusDot,
  Accordion,
  AccordionItem,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  CodeBlock,
  InlineCode,
  ConfirmModal,
} from "@legalwork/ui/react";

/* -------------------------------------------------------------- helpers */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">{title}</h2>
      <Card padding="lg" className="space-y-5">
        {children}
      </Card>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-2xs font-medium uppercase tracking-wide text-tertiary">{label}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function Swatch({ name, className, value }: { name: string; className: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <div className={`h-14 rounded-xl border border-subtle ${className}`} />
      <div className="text-xs font-medium text-ink">{name}</div>
      <div className="text-2xs text-tertiary">{value}</div>
    </div>
  );
}

/* -------------------------------------------------------------- gallery */

function Gallery() {
  const [scope, setScope] = useState("public");
  const [view, setView] = useState("plugins");
  const [modalOpen, setModalOpen] = useState(false);
  const [effort, setEffort] = useState(70);
  const { toast } = useToast();

  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-8 py-10 md:grid-cols-2">
      {/* Buttons */}
      <Section title="Buttons">
        <Field label="Variants">
          <Button variant="primary">Primary</Button>
          <Button variant="accent">Accent</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="subtle">Subtle</Button>
          <Button variant="danger">Delete</Button>
        </Field>
        <Field label="Sizes & icons">
          <Button size="sm" variant="secondary" leading={<Plus />}>Small</Button>
          <Button size="md" variant="primary" leading={<Sparkles />}>Create</Button>
          <Button size="lg" variant="secondary" trailing={<ChevronDown />}>Large</Button>
          <Button variant="secondary" pill leading={<Github />}>Install</Button>
        </Field>
      </Section>

      {/* Icon buttons + tooltip */}
      <Section title="Icon buttons & tooltip">
        <Field label="Variants">
          <IconButton aria-label="Search" variant="ghost"><Search /></IconButton>
          <IconButton aria-label="Settings" variant="secondary"><Settings /></IconButton>
          <IconButton aria-label="Add" variant="subtle"><Plus /></IconButton>
          <IconButton aria-label="Send" variant="accent" shape="round"><ArrowUp /></IconButton>
          <IconButton aria-label="Delete" variant="ghost"><Trash2 /></IconButton>
        </Field>
        <Field label="Tooltip (hover)">
          <Tooltip label="New task" side="top">
            <IconButton aria-label="New task" variant="secondary"><SquarePen /></IconButton>
          </Tooltip>
          <Tooltip label="Open files  ⌘P" side="bottom">
            <Button variant="subtle" size="sm">Hover me</Button>
          </Tooltip>
        </Field>
      </Section>

      {/* Inputs */}
      <Section title="Inputs & selects">
        <SearchInput placeholder="Search plugins" />
        <Input placeholder="Firm name" />
        <div className="flex items-center gap-3">
          <span className="text-base text-subtext">Language</span>
          <Select
            defaultValue="auto"
            options={[
              { value: "auto", label: "Auto detect" },
              { value: "en", label: "English" },
              { value: "de", label: "Deutsch" },
            ]}
          />
        </div>
        <Textarea rows={2} placeholder="Ask for approval…" />
      </Section>

      {/* Toggles + segmented + slider */}
      <Section title="Controls">
        <Field label="Switch">
          <Switch defaultChecked />
          <Switch defaultChecked={false} />
          <Switch defaultChecked size="sm" />
          <Switch disabled defaultChecked />
        </Field>
        <Field label="Scope (segmented)">
          <SegmentedControl
            value={scope}
            onValueChange={setScope}
            items={[
              { value: "public", label: "Public" },
              { value: "eigenwelt", label: "Eigenweltlabs" },
              { value: "personal", label: "Personal" },
            ]}
          />
        </Field>
        <div className="space-y-2">
          <div className="text-2xs font-medium uppercase tracking-wide text-tertiary">
            Reasoning effort (aurora slider)
          </div>
          <Slider variant="aurora" value={effort} onValueChange={setEffort} aria-label="Effort" />
        </div>
      </Section>

      {/* Tabs + menu */}
      <Section title="Tabs & dropdown">
        <Field label="View tabs">
          <Tabs
            value={view}
            onValueChange={setView}
            items={[
              { value: "plugins", label: "Plugins" },
              { value: "skills", label: "Skills" },
            ]}
          />
        </Field>
        <Field label="Project picker (nested submenu)">
          <Menu
            minWidth={260}
            trigger={
              <Button variant="subtle" leading={<Folder />} trailing={<ChevronDown />}>
                Lease Agreement
              </Button>
            }
          >
            <MenuSearch placeholder="Search projects" />
            <MenuItem icon={<Folder />} checked>Lease Agreement</MenuItem>
            <MenuItem icon={<Folder />}>holzapfelbums</MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Plus />}
              submenu={
                <>
                  <MenuItem icon={<Plus />}>Start from scratch</MenuItem>
                  <MenuItem icon={<FolderOpen />}>Use an existing folder</MenuItem>
                </>
              }
            >
              New project
            </MenuItem>
            <MenuItem icon={<X />}>Don&apos;t work in a project</MenuItem>
          </Menu>
        </Field>
      </Section>

      {/* Badges + avatars + app icons */}
      <Section title="Badges, avatars & app icons">
        <Field label="Badges">
          <Badge tone="neutral">Draft</Badge>
          <Badge tone="accent" dot>Active</Badge>
          <Badge tone="success" dot>Signed</Badge>
          <Badge tone="warning">Review</Badge>
          <Badge tone="danger">Overdue</Badge>
        </Field>
        <Field label="Avatars">
          <Avatar name="Erika Beispiel" size="lg" />
          <Avatar name="Chris Meier" size="md" />
          <Avatar name="Eigenweltlabs" size="sm" />
        </Field>
        <Field label="App icons">
          <AppIcon color="linear-gradient(135deg,#2b7de9,#1a5fc4)"><FileText /></AppIcon>
          <AppIcon color="linear-gradient(135deg,#e5484d,#c33)"><FileText /></AppIcon>
          <AppIcon color="linear-gradient(135deg,#12a150,#0b7a3c)"><Grid2x2 /></AppIcon>
          <AppIcon><Sparkles /></AppIcon>
        </Field>
      </Section>

      {/* Feedback: modal + toast */}
      <Section title="Feedback">
        <Field label="Overlays">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button
            variant="secondary"
            onClick={() => toast({ title: "Redline saved", description: "Mietvertrag.docx updated.", tone: "success" })}
          >
            Show toast
          </Button>
        </Field>
      </Section>

      {/* Files */}
      <Section title="Document rows">
        <FileRow name="Mietvertrag.docx" kind="Document" interactive trailing={<Button size="sm" variant="secondary" trailing={<ChevronDown />}>Open in</Button>} />
        <FileRow name="Mietvertrag.review.md" kind="Document" interactive />
        <FileRow name="Nr_033_Widerklage.docx" kind="Document" interactive />
      </Section>

      {/* Assembled settings card */}
      <section className="space-y-3 md:col-span-2">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">
          Assembled · settings panel
        </h2>
        <Card padding="none" className="overflow-hidden">
          <Row
            leading={<Settings />}
            title="Default permissions"
            description="LegalWork can read and edit files in its workspace. It can ask for additional access when needed."
            trailing={<Switch defaultChecked />}
          />
          <Divider inset />
          <Row
            leading={<Puzzle />}
            title="Auto-review"
            description="Automatically review requests for additional access. Auto-review can make mistakes."
            trailing={<Switch defaultChecked />}
          />
          <Divider inset />
          <Row
            leading={<FileText />}
            title="Default file open destination"
            description="Where files and folders open by default"
            trailing={
              <Select
                defaultValue="cursor"
                options={[
                  { value: "cursor", label: "Cursor" },
                  { value: "vscode", label: "VS Code" },
                  { value: "system", label: "System default" },
                ]}
              />
            }
          />
          <Divider inset />
          <Row
            title="Default terminal location"
            description="Where the terminal shortcut and environment actions open"
            trailing={
              <SegmentedControl
                size="sm"
                defaultValue="bottom"
                items={[
                  { value: "bottom", label: "Bottom" },
                  { value: "right", label: "Right" },
                ]}
              />
            }
          />
        </Card>
      </section>

      {/* Color tokens */}
      <section className="space-y-3 md:col-span-2">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">Color tokens</h2>
        <Card padding="lg">
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
            <Swatch name="Primary" className="bg-primary" value="navy #011627" />
            <Swatch name="Accent" className="bg-brand" value="#0b84fe" />
            <Swatch name="Surface" className="bg-surface" value="#ffffff" />
            <Swatch name="Sunken" className="bg-sunken" value="#f7f7f8" />
            <Swatch name="Success" className="bg-success" value="#12a150" />
            <Swatch name="Danger" className="bg-danger" value="#e5484d" />
          </div>
        </Card>
      </section>

      {/* Type scale */}
      <section className="space-y-3 md:col-span-2">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">Typography · Geist</h2>
        <Card padding="lg" className="space-y-2">
          <div className="text-3xl font-semibold tracking-tight">Firm-owned models that compound.</div>
          <div className="text-xl font-medium">Review the lease agreement before signing.</div>
          <div className="text-base text-ink">Body. The monthly rent is a gross warm rent covering all operating costs.</div>
          <div className="text-sm text-subtext">Secondary · Mietvertrag.docx · Document · DOCX</div>
          <div className="flex items-center gap-1.5 text-tertiary">
            <span className="text-xs">Open files</span>
            <Kbd>⌘</Kbd><Kbd>P</Kbd>
            <Check className="size-3.5 text-success" />
          </div>
        </Card>
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Delete this matter?"
        description="Lease Agreement and its 6 documents will be permanently removed. This cannot be undone."
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setModalOpen(false)}>Delete matter</Button>
          </>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------ app scene */

function AppScene() {
  const [effort, setEffort] = useState(72);
  const { toast } = useToast();

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="flex h-[640px] overflow-hidden rounded-3xl border border-line bg-canvas shadow-sm">
        {/* Sidebar */}
        <Sidebar className="border-r border-subtle">
          <div className="flex items-center justify-between px-2.5 pb-2">
            <span className="text-md font-semibold text-ink">LegalWork</span>
            <IconButton aria-label="Search" variant="ghost" size="sm"><Search /></IconButton>
          </div>
          <SidebarItem icon={<SquarePen />}>New task</SidebarItem>
          <SidebarItem icon={<Calendar />}>Scheduled</SidebarItem>
          <SidebarItem icon={<Puzzle />} active>Plugins</SidebarItem>
          <SidebarItem icon={<Grid2x2 />}>Sites</SidebarItem>
          <SidebarItem icon={<MessageSquarePlus />}>Chat</SidebarItem>

          <SidebarGroup label="Projects">
            <SidebarItem icon={<Folder />}>holzapfelbums</SidebarItem>
            <SidebarItem indent>how are my workers doing</SidebarItem>
            <SidebarItem indent>New task</SidebarItem>
            <SidebarItem icon={<Folder />}>Lease Agreement</SidebarItem>
            <SidebarItem indent>List folder contents</SidebarItem>
          </SidebarGroup>

          <div className="mt-auto flex items-center gap-2 px-1 pt-3">
            <Avatar name="Eigenweltlabs" size="sm" />
            <span className="text-base text-subtext">Eigenweltlabs</span>
          </div>
        </Sidebar>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-subtle px-6 py-3.5">
            <Tabs
              defaultValue="plugins"
              items={[
                { value: "plugins", label: "Plugins" },
                { value: "skills", label: "Skills" },
              ]}
            />
            <Menu
              align="end"
              trigger={<Button variant="secondary" size="sm" trailing={<ChevronDown />}>Create</Button>}
            >
              <MenuItem icon={<Plus />}>New plugin</MenuItem>
              <MenuItem icon={<Sparkles />}>New skill</MenuItem>
            </Menu>
          </div>

          <div className="flex-1 space-y-6 overflow-auto px-6 py-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-ink">Plugins</h1>
              <p className="mt-1 text-md text-subtext">Work with LegalWork across your favorite tools</p>
            </div>

            <SearchInput inputSize="lg" placeholder="Search plugins" />

            <div>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-md font-semibold text-ink">Installed</span>
                <IconButton aria-label="Configure" variant="ghost" size="sm"><Settings /></IconButton>
              </div>
              <div className="flex flex-wrap gap-2.5">
                <AppIcon size="lg" color="linear-gradient(135deg,#2b7de9,#1a5fc4)"><FileText /></AppIcon>
                <AppIcon size="lg" color="linear-gradient(135deg,#e5484d,#c33)"><FileText /></AppIcon>
                <AppIcon size="lg" color="linear-gradient(135deg,#12a150,#0b7a3c)"><Grid2x2 /></AppIcon>
                <AppIcon size="lg" color="linear-gradient(135deg,#e5920b,#c47600)"><Sparkles /></AppIcon>
                <AppIcon size="lg"><Puzzle /></AppIcon>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <SegmentedControl
                defaultValue="public"
                items={[
                  { value: "public", label: "Public" },
                  { value: "eigenwelt", label: "Eigenweltlabs" },
                  { value: "personal", label: "Personal" },
                ]}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { name: "Computer Use", desc: "Control Mac apps from LegalWork", color: "linear-gradient(135deg,#0b84fe,#0967c6)" },
                { name: "Chrome", desc: "Control Chrome with LegalWork", color: "linear-gradient(135deg,#e5484d,#f5a623)" },
                { name: "Spreadsheets", desc: "Create and edit spreadsheet files", color: "linear-gradient(135deg,#12a150,#0b7a3c)" },
                { name: "GitHub", desc: "Triage PRs, issues, CI", color: "linear-gradient(135deg,#35353b,#0d0d0f)" },
              ].map((p) => (
                <Card key={p.name} padding="md" className="flex items-center gap-3">
                  <AppIcon size="lg" color={p.color}><Puzzle /></AppIcon>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold text-ink">{p.name}</div>
                    <div className="truncate text-sm text-subtext">{p.desc}</div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => toast({ title: `Installed ${p.name}`, tone: "success" })}>
                    Install
                  </Button>
                </Card>
              ))}
            </div>
          </div>

          {/* Composer with reasoning-slider popover */}
          <div className="border-t border-subtle px-6 py-4">
            <Composer
              placeholder="Ask for approval…"
              onSubmit={(t) => toast({ title: "Sent", description: t })}
              pills={
                <>
                  <Badge tone="accent" size="sm"><FileText className="size-3" /> Documents</Badge>
                  <Badge tone="neutral" size="sm"><Sparkles className="size-3" /> Template Creator</Badge>
                </>
              }
              toolbar={
                <Menu
                  side="top"
                  align="end"
                  minWidth={240}
                  contentClassName="p-3"
                  trigger={<ModelChip name="5.6 Sol" level="High" />}
                >
                  <div className="flex items-center justify-between pb-2">
                    <button className="flex items-center gap-1 text-base font-medium text-ink">
                      Advanced <ChevronRight className="size-4 text-tertiary" />
                    </button>
                    <Zap className="size-4 fill-brand text-brand" />
                  </div>
                  <Slider variant="aurora" value={effort} onValueChange={setEffort} aria-label="Reasoning effort" />
                </Menu>
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- gap gallery */

function GapGallery() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-8 py-10 md:grid-cols-2">
      <Section title="Spinners & skeletons">
        <Field label="Spinner / Dots">
          <div className="flex items-center gap-5">
            <Spinner size="sm" />
            <Spinner size="md" tone="brand" />
            <Spinner size="lg" tone="subtle" />
            <span className="flex items-center gap-2 text-base text-subtext">Thinking <Dots /></span>
          </div>
        </Field>
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1"><SkeletonText lines={3} /></div>
        </div>
      </Section>

      <Section title="Checkbox, progress & status">
        <Field label="Checkbox">
          <Checkbox defaultChecked aria-label="a" />
          <Checkbox aria-label="b" />
          <Checkbox indeterminate aria-label="c" />
          <Checkbox disabled defaultChecked aria-label="d" />
          <label className="flex items-center gap-2 text-base text-ink"><Checkbox defaultChecked /> Privileged</label>
        </Field>
        <div className="space-y-3">
          <Progress value={68} />
          <Progress value={100} tone="success" size="sm" />
          <Progress value={92} tone="warning" />
        </div>
        <Field label="Status dots">
          <StatusDot tone="success" label="Connected" />
          <StatusDot tone="warning" label="Degraded" />
          <StatusDot tone="danger" label="Offline" />
          <StatusDot tone="brand" label="Live" pulse />
        </Field>
      </Section>

      <section className="space-y-3 md:col-span-2">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">Alerts</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Alert tone="info" title="Matter synced" onClose={() => {}}>Documents from the Acme acquisition are now available.</Alert>
          <Alert tone="warning" title="Private eval pending">Partner corrections not reviewed since the last cycle.</Alert>
          <Alert tone="danger" title="Redline conflict" action={<Button size="sm" variant="secondary">Resolve</Button>}>Two reviewers edited clause 4.2.</Alert>
          <Alert tone="success" title="Draft accepted" onClose={() => {}} />
        </div>
      </section>

      <Section title="Action rows">
        <ActionRow icon={<Sparkles />} title="AI Providers" description="Connect services that provide AI models." />
        <ActionRow icon={<Settings />} title="Tool Permissions" description="Decide what LegalWork can do on its own." tone="accent" />
        <ActionRow icon={<FileText />} title="Working…" description="Loading state" loading />
      </Section>

      <Section title="Accordion & fields">
        <Accordion>
          <AccordionItem title="What does redline review do?" defaultOpen>
            Marks up contracts as tracked changes with a rationale for each edit.
          </AccordionItem>
          <AccordionItem title="Where does my data go?">
            The agent runs locally; data is only shared with the model you choose.
          </AccordionItem>
        </Accordion>
        <FieldRow label="Firm name" description="Shown on generated documents">
          <Input inputSize="sm" defaultValue="Muster GmbH" className="w-40" />
        </FieldRow>
      </Section>

      <section className="space-y-3 md:col-span-2">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">Table, code & confirm</h2>
        <Card padding="none" className="overflow-hidden">
          <Table>
            <THead>
              <Tr><Th>Matter</Th><Th>Status</Th><Th>Updated</Th></Tr>
            </THead>
            <TBody>
              <Tr><Td>Mietvertrag.docx</Td><Td><Badge tone="success" dot>Signed</Badge></Td><Td className="text-subtext">Jul 11</Td></Tr>
              <Tr><Td>Nr_033_Widerklage.docx</Td><Td><Badge tone="warning">Review</Badge></Td><Td className="text-subtext">Jul 10</Td></Tr>
              <Tr><Td>MUTUAL NON.docx</Td><Td><Badge tone="neutral">Draft</Badge></Td><Td className="text-subtext">Jul 9</Td></Tr>
            </TBody>
          </Table>
        </Card>
        <div className="grid gap-3 md:grid-cols-2">
          <CodeBlock filename="review.md" code={"# Lease review\n- §3 rent: gross warm rent\n- §16 references §2"} />
          <div className="space-y-3">
            <p className="text-base text-subtext">Inline <InlineCode>Mietvertrag.docx</InlineCode> chip in prose.</p>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>Delete matter…</Button>
          </div>
        </div>
      </section>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => setConfirmOpen(false)}
        tone="danger"
        title="Delete this matter?"
        description="Lease Agreement and its 6 documents will be permanently removed."
        confirmLabel="Delete matter"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ root */

export function App() {
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState("components");

  return (
    <div className={dark ? "dark" : ""}>
      <ToastProvider>
        <div className="min-h-screen bg-sunken font-sans text-ink">
          <div className="sticky top-0 z-20 flex items-center justify-between border-b border-subtle bg-surface/80 px-8 py-4 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-fg">
                <Sparkles className="size-[18px]" />
              </span>
              <div>
                <div className="text-md font-semibold leading-tight">LegalWork Design System</div>
                <div className="text-xs text-subtext">Navy primary · blue interactive · Geist</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Tabs
                value={tab}
                onValueChange={setTab}
                items={[
                  { value: "components", label: "Components" },
                  { value: "parts", label: "New parts" },
                  { value: "scene", label: "App scene" },
                ]}
              />
              <IconButton aria-label="Toggle theme" variant="secondary" onClick={() => setDark((d) => !d)}>
                {dark ? <Sun /> : <Moon />}
              </IconButton>
            </div>
          </div>

          {tab === "components" ? <Gallery /> : tab === "parts" ? <GapGallery /> : <AppScene />}
        </div>
      </ToastProvider>
    </div>
  );
}
