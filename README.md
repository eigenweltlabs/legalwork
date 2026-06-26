# LegalWork

A local computer-use agent for law firms, from Eigenwelt Labs. Point it at a folder of documents and ask in plain English — it reads, drafts, and redlines them on your own machine, using the model you connect. Everything stays owned by the firm.

## Watch it work

<video src="https://github.com/eigenweltlabs/legalwork/raw/dev/media/launch.mp4" poster="https://github.com/eigenweltlabs/legalwork/raw/dev/media/launch-poster.jpg" controls width="100%"></video>

<sub>A 40-second tour: launch the app, point it at a matter folder, pick a model, review a stack of documents, and redline an NDA — all on your own machine. Not playing inline? <a href="https://github.com/eigenweltlabs/legalwork/raw/dev/media/launch.mp4">Watch the film</a>.</sub>

## What it does

- **Review & redline** contracts as tracked changes, right in Word.
- **Tabular review** — extract terms across many documents into a sourced grid.
- **Draft** briefs, memos, contracts, and engagement letters.
- **Bring your own model** — AWS Bedrock, Azure OpenAI, or any provider. Your data is only ever shared with the model you choose.
- **Runs on this machine** by default; connect a remote worker only when you want to.
- **Extend it** with skills, plugins, and MCP connectors, managed in **Settings → Extensions** and shared across every workspace.

## Develop

Requirements: Node.js + `pnpm@10.27.0`, **Bun 1.3.9+**, the Rust toolchain (Tauri), and the `opencode` CLI on PATH. macOS needs Xcode Command Line Tools; Linux needs the WebKitGTK 4.1 dev packages.

```bash
pnpm install
pnpm dev        # desktop app (isolated dev engine state)
pnpm dev:ui     # web UI only
```

Checks: `pnpm typecheck` · `pnpm build` · `pnpm test:e2e`.

## Contributing

Read `AGENTS.md` first. Run `pnpm install`, then verify with `pnpm typecheck` and `pnpm test:e2e` before opening a PR.

## License

MIT — see `LICENSE`.
