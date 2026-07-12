# LegalWork

A local computer-use agent for law firms, from Eigenwelt Labs. Point it at a folder of documents and ask in plain English — it reads, drafts, and redlines them on your own machine, using the model you connect. Everything stays owned by the firm.

https://github.com/user-attachments/assets/4a576c3a-7c2a-46c6-9856-1254282b1b70



## What it does

- **Review & redline** contracts as tracked changes, right in Word.
- **Tabular review** — extract terms across many documents into a sourced grid.
- **Draft** briefs, memos, contracts, and engagement letters.
- **Bring your own model** — AWS Bedrock, Azure OpenAI, or any provider. Your data is only ever shared with the model you choose.
- **Runs on this machine** by default; connect a remote worker only when you want to.
- **Extend it** with skills, plugins, and MCP connectors, managed in **Settings → Extensions** and shared across every workspace.

## Telemetry

Official builds can send **anonymous usage statistics** — event names, counts,
and durations, never your documents, prompts, or matter content — to our
EU-hosted PostHog so we can improve the app. Events carry a random per-launch
id (nothing is stored on your device) and location no finer than city. The
option is shown on the welcome screen at first launch and can be turned off
anytime in **Settings → Privacy**. Development builds (`pnpm dev`) send
nothing. Details: [TERMS.md](./TERMS.md) and the
[privacy policy](https://eigenweltlabs.com/privacy).

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
