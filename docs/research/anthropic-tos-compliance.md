# Anthropic Terms of Service Compliance

This document explains how Yep Anywhere differs from third-party Claude tools that received takedown notices from Anthropic in 2025-2026.

## Background: What Got Blocked

In late 2025 and early 2026, Anthropic sent takedown notices to several third-party Claude Code clients, including:

- **OpenCode** - blocked January 2026
- **Crush** (Charmbracelet) - [removed Claude Code support](https://github.com/charmbracelet/crush/pull/1783)
- **Windsurf** - blocked June 2025

These projects were blocked for **spoofing the Claude Code client identity** to access Claude Max subscription pricing ($200/month) instead of paying per-token API rates.

### The Technical Issue

Claude Max subscriptions offer dramatically cheaper access than API pricing (users reported $1000+ monthly API costs reduced to $200). The blocked tools would:

1. Send fake HTTP headers pretending to be the official Claude Code CLI
2. Trick Anthropic's servers into granting subscription-tier pricing
3. Provide their own alternative UI while freeloading on pricing meant only for Anthropic's official tool

An Anthropic engineer confirmed: *"We tightened our safeguards against spoofing the Claude Code harness."*

Section D.4 of Anthropic's commercial terms prohibits:
- Using the API to build competing products
- Reverse engineering or duplicating the services

## How Yep Anywhere Is Different

Yep Anywhere does **none of the above**. Here's what we actually do:

### 1. We Use the Official SDK

We depend on `@anthropic-ai/claude-agent-sdk`, Anthropic's official published SDK:

```json
"@anthropic-ai/claude-agent-sdk": "^0.1.76"
```

We call the SDK's `query()` function directly without modification or header spoofing.

### 2. We Don't Replace or Intercept Authentication

Users provide their own authentication through one of two methods:

- **API Key**: User sets `ANTHROPIC_API_KEY` environment variable (pays standard API rates)
- **OAuth**: User runs `claude` CLI themselves to authenticate, which creates `~/.claude/.credentials.json`

We do provide a `/login` convenience command that helps users re-authenticate remotely when their credentials expire. This works by automating the Claude CLI's own `/login` command via tmux - we parse the OAuth URL from CLI output and relay it to users, who then complete Anthropic's official OAuth flow in their browser. We're not bypassing or replacing the auth system, just making it accessible when you can't SSH to your machine.

### 3. We Don't Spoof Client Identity

Our code makes no attempt to impersonate Claude Code or any other client. We pass requests to the SDK as-is, which identifies itself appropriately.

### 4. We're a Remote Interface, Not a Replacement

Yep Anywhere is a mobile-friendly supervisor for Claude Code sessions running on your own machine. Think of it like SSH for AI agents - we provide remote access to sessions, not a replacement client.

## Code Reference

See `packages/server/src/sdk/providers/claude.ts` for our SDK integration:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// We call the SDK directly with user's own credentials
iterator = query({
  prompt: queue.generator(),
  options: {
    cwd: options.cwd,
    resume: options.resumeSessionId,
    // ... standard SDK options
  },
});
```

## Summary

| Aspect | Blocked Tools | Yep Anywhere |
|--------|---------------|--------------|
| Client identity spoofing | Yes | No |
| Header manipulation | Yes | No |
| Pricing tier circumvention | Yes | No |
| Uses official SDK | No (custom API calls) | Yes |
| Handles user auth | Yes (OAuth proxy/interception) | Convenience only (relays CLI's official OAuth) |

We believe this approach aligns with Anthropic's terms of service. Users pay for their own Claude access through legitimate channels, and we provide a remote interface to manage sessions.

## Disclaimer

This document represents our understanding as of January 2026. We are not lawyers and this is not legal advice. If Anthropic has concerns about our implementation, we welcome the conversation.

## References

- [Anthropic blocks third-party Claude Code access (Hacker News)](https://news.ycombinator.com/item?id=46549823)
- [Charmbracelet Crush removal PR](https://github.com/charmbracelet/crush/pull/1783)
- [VentureBeat: Anthropic cracks down on unauthorized Claude usage](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)
