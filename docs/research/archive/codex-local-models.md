# Codex Local Model Support

## Problem

The `@openai/codex-sdk` doesn't expose the `--oss` flag needed for local models. The SDK is intentionally limited to OpenAI cloud models ([Issue #5459](https://github.com/openai/codex/issues/5459) closed as "Not Planned").

## Solution

Spawn `codex exec --oss` directly for local models, keeping the SDK for cloud models.

## Why Not LiteLLM Proxy?

LiteLLM only proxies API calls - it doesn't change prompt format. The `--oss` flag optimizes prompts/tool schemas for open-source models, which matters for tool calling reliability.

## Implementation

| Provider | Backend | Use Case |
|----------|---------|----------|
| `codex` | SDK | Cloud models (gpt-4, o3, etc.) |
| `codex-oss` | CLI spawn | Local models via Ollama |

Both write sessions to `~/.codex/sessions/` with identical format. The `model_provider` field in session metadata distinguishes them (`"openai"` vs `"ollama"`).

## CLI Usage

```bash
codex exec --oss --local-provider ollama --model qwen2.5-coder:0.5b \
  --experimental-json -s danger-full-access --cd /path/to/project
```

Output is JSON stream: `thread.started`, `turn.started`, `item.completed`, etc.
