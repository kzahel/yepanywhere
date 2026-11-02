# Codex OSS - Local Models

The CodexOSS provider runs local model inference through the Codex CLI, which
handles session management and tool calling.

There are two ways to point it at a model server:

- **A configured model service.** Add the endpoint under Settings → Providers →
  Model services and allow CodexOSS to use it (new services already have the
  "Allow CodexOSS" checkbox checked). YA then lists that endpoint's
  `/v1/models` and launches with Codex model-provider overrides on the command
  line, so any OpenAI-compatible server — vLLM, llama.cpp, LM Studio, Ollama —
  works without Ollama being installed and without editing `~/.codex/config.toml`.
  See also [gateway services](../topics/gateway-services.md).
- **Ollama, the original path**, described below: `codex exec --oss` with models
  enumerated from `ollama list`. This is what runs when no service opts in.

## Requirements

- [Ollama](https://ollama.ai/) installed and running
- [Codex CLI](https://github.com/openai/codex) installed (`npm install -g @openai/codex`)
- Models with **32K+ context window** (see below)

## Context Window Issue

Codex's system prompt is ~6K tokens. Ollama's default context window is 4K tokens. When the prompt exceeds the context window, Ollama silently truncates it, losing conversation history.

**Symptom:** Model says "I don't have information on previous interactions" even though you just told it something.

**Solution:** Create model variants with larger context windows.

## Creating 32K Context Models

### Qwen 2.5 Coder (32B)

```bash
cat > /tmp/Modelfile-qwen-32k << 'EOF'
FROM qwen2.5-coder:32b-instruct-q4_K_M
PARAMETER num_ctx 32768
EOF

ollama create qwen2.5-coder:32b-32k -f /tmp/Modelfile-qwen-32k
```

### Mistral Small (24B)

```bash
cat > /tmp/Modelfile-mistral-32k << 'EOF'
FROM mistral-small:24b
PARAMETER num_ctx 32768
EOF

ollama create mistral-small:24b-32k -f /tmp/Modelfile-mistral-32k
```

### Generic Template

```bash
cat > /tmp/Modelfile-32k << 'EOF'
FROM your-model:tag
PARAMETER num_ctx 32768
EOF

ollama create your-model:tag-32k -f /tmp/Modelfile-32k
```

After creating, select the `-32k` variant in the Yep Anywhere UI.

## Codex Configuration

Configure `~/.codex/config.toml` to use Ollama with the Responses API:

```toml
# Default provider for --oss flag
oss_provider = "ollama"

# Ollama provider configuration
[model_providers.ollama]
name = "Ollama"
base_url = "http://localhost:11434/v1"
wire_api = "responses"
```

Current Codex releases accept only `wire_api = "responses"`; a provider that
says `chat` fails to load (`wire_api = "chat" is no longer supported`,
codex-cli 0.154.0).

## How It Works

1. **First turn:** Uses `codex exec --oss --json` to start a new session
2. **Subsequent turns:** Uses `codex exec resume <session_id>` to continue the conversation
3. **Session persistence:** Codex stores sessions in `~/.codex/sessions/`

The provider handles both JSON output (first turn) and text output (resume turns).

YA's public session id can differ from Codex's native UUID. Scoped continuation
checks the actual Codex store and rollout header before starting the CLI, and
uses the native UUID for `exec resume` while keeping YA identity in APIs and
history. A failed CLI turn reports its error; stopping the session releases its
input wait and installation lease. See the
[Codex session contract](../topics/codex-sessions.md#scoped-codex-oss-continuation).

## Troubleshooting

### Check for Context Truncation

```bash
journalctl -u ollama --since "5 minutes ago" | grep truncat
```

If you see messages like:
```
msg="truncating input prompt" limit=4096 prompt=5990
```

Your model needs a larger context window. Create a 32K variant as shown above.

### Check Context Size Being Used

```bash
journalctl -u ollama --since "5 minutes ago" | grep n_ctx
```

Good (32K):
```
llama_context: n_ctx = 32768
```

Bad (default 4K):
```
llama_context: n_ctx = 4096
```

### Deprecation Warning

You may see:
```
deprecated: Support for the "chat" wire API is deprecated...
```

This is a Codex CLI bug where `resume` doesn't use the configured `wire_api`. The functionality still works; it's just using the older Chat API instead of Responses API.

## Available Models

List your Ollama models:
```bash
ollama list
```

Models with `-32k` suffix have been configured with larger context:
```
qwen2.5-coder:32b-32k    (32K context)
mistral-small:24b-32k    (32K context)
qwen2.5-coder:32b        (4K context - will truncate!)
```

## Memory Requirements

Larger context windows require more VRAM:
- 4K context: Base model size
- 32K context: ~8x KV cache size increase

For a 32B model with 32K context, expect ~24-32GB VRAM usage.
