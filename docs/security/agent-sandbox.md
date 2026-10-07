# Protected command execution

Managed LegalWork workers execute agent shell commands and community calculation scripts in a disposable Linux VM. The desktop bundle includes QEMU 11.1.2, the Linux kernel, Python, Node, and the guest supervisor. Users do not install Docker, WSL, Homebrew, MSYS2, or a Python runtime. Missing or damaged resources block execution.

The desktop enables this for its managed engine. Standalone servers using `LEGALWORK_MANAGE_OPENCODE=1` enforce the same boundary and require the matching runtime resources. An externally managed engine has its own execution policy; connecting it does not automatically sandbox it.

## Boundary and permissions

The VM has no network device, host disk, shared filesystem, clipboard, or host control socket. The host copies approved folder contents into the guest. The command runs without root privileges and with a clean environment. The guest communicates through a bounded virtio-serial protocol. The host validates every message, including messages a compromised guest kernel could manufacture.

LegalWork checks shell and read permissions before starting. Folders are read-only unless the command requests writes and edit permissions allow them. `ask` requires the host's approval even when unrelated server operations use automatic approvals. Agent and session restrictions also apply. Scoped shell, read, and edit restrictions apply conservatively to the entire command because Python can launch arbitrary descendants. Changing workspace or global permissions cancels active commands.

For HTTP and HTTPS, a guest-local proxy buffers the complete request. HTTPS is terminated with an ephemeral guest certificate; CONNECT never becomes a raw tunnel. The host binds authorization to the URL, method, final headers, and full body before DNS resolution. It rejects private, reserved, loopback, and metadata destinations and connects to the validated IP. Redirects require another request. Direct sockets and DNS have no route out, even if a script clears its proxy settings.

After the command finishes, the host kills the VM before copying changes back. Copy-back rejects unauthorized paths, symlinks, Windows device aliases, alternate data streams, protected execution settings, and concurrent host edits. Atomic replacement of individual files preserves external hard-link targets. Cancellation or a runtime failure discards pending guest output. Copy-back is not a transaction across all files: an I/O failure partway through may leave earlier validated changes applied.

The engine's built-in host shell is disabled independently of the sandbox plugin. Session overrides cannot restore it. Direct terminal/shell endpoints, engine config mutation, and command-template host interpolation are blocked. Managed engine configuration discovery excludes project and home plugin directories. Explicitly installed plugins and connected MCPs remain trusted host integrations.

Installed skill instructions remain discoverable. A command may request installed skill names through `skills`; their resource folders appear at `/skills/0`, `/skills/1`, and so on. Skill and read permissions apply, and these copies are always read-only. Python document libraries (python-docx, openpyxl, python-pptx, pypdf, ReportLab and Pillow) are bundled for offline use.

## Scope and limits

This isolates script execution. Model-provider requests, connected apps, browser/computer-use tools, ordinary file tools, and the LegalWork server remain host capabilities governed by their own permissions. The sandbox does not turn an unrestricted connector into a confined tool. The host application, OS, QEMU, and signed runtime resources remain part of the trusted boundary.

Each command starts fresh. Installed packages and changes outside approved folders disappear afterwards. Commands use Linux paths (`/workspace`, `/authorized/0`, etc.), not Windows or macOS paths. Snapshots are limited to 512 MiB and 10,000 files, with 128 MiB per file. Symlinks and special files are refused. `.git`, `.opencode`, environment files, shell startup files, and app metadata are excluded; `.legalwork/scratch` is available for task files. HTTP request and response bodies are limited to 4 MiB and 16 MiB. Two VMs may run concurrently.

macOS uses Hypervisor.framework acceleration when `kern.hv_support` reports availability, with software emulation for hosts that cannot virtualize (including hosted CI). Windows currently uses QEMU software emulation so a machine without virtualization can still execute protected commands. This is slower than hardware acceleration. No Windows administrator setup is required at runtime.

Windows uses a unique named pipe for the host side of virtio-serial because QEMU's Windows stdio backend can drop bytes under backpressure. The guest loops on partial character-device writes and verifies input file hashes. The test suite includes a multi-megabyte binary round trip.

## Why this approach

[OpenAI's Windows sandbox explanation](https://openai.com/index/building-codex-windows-sandbox/) describes a native design using restricted execution identities and Windows access controls. [Codex Windows documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox) distinguishes the elevated implementation from a weaker unelevated fallback. On macOS, [Codex's source](https://github.com/openai/codex/blob/2dae757b8713d3317e8da58828bdac821386982c/codex-rs/sandboxing/src/seatbelt.rs) uses Apple's Seatbelt through `/usr/bin/sandbox-exec`, with filesystem and network policies. Neither design requires users to install Docker. A proxy without OS enforcement cannot contain arbitrary Python.

[Anthropic's containment explanation](https://www.anthropic.com/engineering/how-we-contain-claude) describes Cowork's VM boundary using Apple Virtualization.framework on macOS and Windows Host Compute System, with trusted host integrations outside it. LegalWork follows the separation between host permissions and guest execution, using a bundled QEMU runtime with no NIC or shared host filesystem.

We also tested Anthropic sandbox-runtime 0.0.78 on Windows 11 ARM64. Raw connections and unauthorized file writes failed, while `getaddrinfo("example.com")` succeeded. Its documented Windows DNS limitation does not meet this feature's strict network requirement. The VM removes that path instead of relying on proxy environment variables or command-text inspection.

## Build and verify

Docker is used only to construct the guest on developer/CI machines. Release and CI workflows produce runtime artifacts for each platform and architecture, run real isolation tests, and include those artifacts in the installer. Build-time package managers are not shipped as prerequisites.

On a Mac development machine:

```sh
node scripts/sandbox/build-guest.mjs arm64
node scripts/sandbox/package-runtime.mjs "$(command -v qemu-system-aarch64)"
LEGALWORK_SANDBOX_INTEGRATION=1 bun test --timeout 180000 apps/server/src/agent-sandbox
pnpm --filter legalwork-server build
LEGALWORK_SANDBOX_INTEGRATION=1 LEGALWORK_TEST_OPENCODE_BIN=/path/to/opencode bun test apps/server/src/agent-sandbox/engine.integration.test.ts
```

For Intel, build `x64` and package `qemu-system-x86_64`. Windows packaging takes the matching QEMU executable from MSYS2 and recursively bundles its imported libraries. The Linux guest may be built on Linux and transferred as a CI artifact. `verify-runtime.mjs` checks resource completeness and hashes before desktop builds. macOS signing preserves the QEMU hypervisor entitlement and updates the resource manifest before sealing the outer application.

`scripts/sandbox/probe.ts` also runs with the desktop's actual Node runtime after bundling with `bun build --target=node`. It verifies direct IPv4, IPv6, UDP and DNS denial, supervisor and host-channel isolation, read-only folders, Python/Node, approved copy-back, and HTTPS request inspection. The engine integration test uses a local fake model, makes the shipped engine call `legalwork_shell`, checks the tool identity, and attempts a direct host-shell escape. It sends no data to a real model provider.
