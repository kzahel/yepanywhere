---
title: Providers
description: Understand the primary Claude Code and Codex integrations and the narrower experimental provider options.
---

Yep Anywhere detects installed agent providers and presents them through one
session interface. Provider support is not binary: each upstream exposes
different control, history, approval, and model primitives.

## Primary providers

| Provider | Status | Expected workflow |
| --- | --- | --- |
| Claude Code | Stable | Sessions, streaming, approvals, diffs, steering, recaps, model and permission controls |
| Codex | Stable | Sessions, streaming, approvals, apply-patch diffs, steering, recaps, model and effort controls |

Authenticate with each provider's official CLI. Yep Anywhere uses the official
provider harness or protocol and does not intercept OAuth tokens.

## Use your subscription plan

Yep Anywhere supports subscription-plan access through Claude Code and Codex.
It launches and resumes the official provider process using the account that
process already has. Sign Claude Code into an eligible Claude plan or Codex into
an eligible ChatGPT plan, and Yep Anywhere uses that provider-managed access.

When Claude Code or Codex exposes subscription limits, Yep Anywhere shows the
applicable usage windows and reset times in the model controls. The provider
still owns plan eligibility, limits, credits, and billing. If the provider is
configured with an API key or pay-as-you-go account, it may bill that route
instead; Yep Anywhere does not choose or change the billing method.

See the providers' current guidance for
[Claude Code subscription access](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
and [Codex access through a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

## Experimental providers

| Provider | Current shape |
| --- | --- |
| OpenCode | Start/resume, history, permissions/questions, tools, thinking, and images; capability parity varies |
| Grok Build | ACP-based sessions with approvals, suggestions, effort, and steering where upstream supports them |
| Gemini CLI | Experimental ACP integration with narrower approval, steering, and history behavior; both Gemini provider names use this adapter |
| Antigravity | Explicitly opt-in ACP integration with text, file references, approvals, streaming, and native history; macOS is live-qualified, Linux remains unqualified, and Windows is unavailable |
| pi | Headless RPC sessions with streaming, tool rendering, model/thinking controls, compaction, forks, and durable history; tools currently run without a Yep Anywhere approval bridge |

Experimental means the integration ships and can be used, but it may require
extra setup, expose fewer controls, or change as its upstream protocol evolves.

## Advanced and legacy Claude routes

**Claude Gateway** is an advanced opt-in route for an operator-configured,
Anthropic-compatible endpoint. Gateway sessions remain separate from regular
Claude sessions and use only the models advertised by that endpoint.

**Claude + Ollama** is retained only for previously configured installations
and existing sessions during its deprecation period. Use Claude Gateway for new
compatible endpoints.

## Session interoperability

Every Claude Code and Codex session appears in Yep Anywhere history, including
sessions started in a terminal, VS Code, or a first-party desktop application.
You can inspect and resume them without importing them into a new database.

Yep Anywhere URLs retain a stable YA session id. Provider-native resume handles
remain an implementation detail unless a provider contract explicitly exposes
a mapping.

## Models and effort

Model and thinking controls appear only when the provider reports support.
Changing model or effort does not imply that every provider applies the change
at the same lifecycle point. If a control is absent, check the provider status
and server version before assuming detection failed.

## Limit provider visibility

An operator can restrict exposed providers:

```bash
ENABLED_PROVIDERS=claude,codex yepanywhere
```

This is useful for shared or focused installations. It does not install,
authenticate, or remove provider software.
