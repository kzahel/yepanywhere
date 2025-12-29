# claude-anywhere

A mobile-first supervisor for Claude Code agents. Manage coding sessions running on your dev machine from anywhere — phone, tablet, or laptop.

> **Work in Progress** — This project is under active development.

## What is this?

Run Claude Code agents on your development machine. Approve tool requests from your phone. No accounts, no cloud dependency — just download and run.

## Features

- **Server-owned processes** — Client disconnects don't interrupt Claude's work
- **Multi-session dashboard** — See all projects at a glance
- **Mobile supervision** — Push notifications for approval requests
- **Message queuing** — Queue instructions while Claude is working

## Tech Stack

- Node.js + TypeScript
- Hono (server)
- React + Vite (client)
- Claude Code SDK

## Development

```bash
pnpm install
pnpm dev
```

## Checks

```bash
pnpm lint       # Biome linter
pnpm typecheck  # TypeScript
pnpm test       # Unit tests
```

## License

MIT
