# Local/OSS Model Integration Research

## Overview

Research into self-hosted and open-source AI coding models as an additional provider option alongside Claude, Codex, and Gemini.

## Key Finding

**LiteLLM proxy enables zero-code integration.** It translates OpenAI-format APIs to Anthropic format, so our existing Claude SDK code works unchanged with local models.

```
Claude Anywhere → Claude SDK → LiteLLM Proxy → Ollama/vLLM → Local Model
                                    ↓
                    (Same JSONL sessions, same code)
```

## Integration Options

| Option | Effort | How It Works |
|--------|--------|--------------|
| **LiteLLM + Ollama** | Low | Point Claude SDK at LiteLLM proxy |
| **Aider subprocess** | Medium | Spawn `aider --json`, parse output |
| **Codex --oss** | Low | Built-in Ollama/LM Studio support |

## Recommended Path

```bash
# 1. Start Ollama with a model
ollama pull qwen2.5-coder:32b
ollama serve

# 2. Start LiteLLM proxy (translates OpenAI → Anthropic format)
litellm --model ollama/qwen2.5-coder:32b --port 4000

# 3. Point Claude SDK at proxy
ANTHROPIC_BASE_URL=http://localhost:4000/v1 pnpm start
```

Existing Claude SDK code works. Sessions persist to same JSONL format.

## Best Models for Agentic Coding (2026)

| Model | Size | Context | Tool Calling | Notes |
|-------|------|---------|--------------|-------|
| **Qwen 2.5 Coder** | 7B-32B | 131K | Good | Best balance, runs on Ollama |
| **Qwen3-Coder** | 32B-480B | 256K | Excellent | Best function calling |
| **Devstral Small 2** | 15B | 128K | Very Good | 68% SWE-bench, consumer GPU |
| **DeepSeek Coder** | 1B-33B | 16K | Partial | Lightweight option |

**Recommendation:** Start with **Qwen 2.5 Coder 32B** - proven, good tool calling, runs on Ollama.

## Infrastructure Options

### Ollama (Easiest)
- URL: `http://localhost:11434/v1`
- Setup: `ollama pull qwen2.5-coder:32b && ollama serve`
- Good for: Development, testing

### vLLM (Production)
- 3.2x faster than Ollama
- Best tool calling support
- Higher setup complexity
- Good for: Production deployment

### LM Studio (Developer-Friendly)
- GUI-based
- Vulkan GPU offloading
- Good for: Local experimentation

## Projects to Study

| Project | Why |
|---------|-----|
| [Aider](https://github.com/Aider-AI/aider) | Production CLI, git-aware, works with any LLM |
| [LiteLLM](https://github.com/BerriAI/litellm) | API translation proxy (critical for integration) |
| [Qwen-Agent](https://github.com/QwenLM/Qwen-Agent) | Tool calling patterns |
| [Continue.dev](https://github.com/continuedev/continue) | IDE-first agent with local model support |

## Provider Implementation

```typescript
// packages/server/src/sdk/providers/local-model.ts
export class LocalModelProvider implements AgentProvider {
  name = 'local' as const;
  displayName = 'Local Model';

  async isInstalled(): Promise<boolean> {
    // Check if Ollama is running at localhost:11434
    try {
      await fetch('http://localhost:11434/api/tags');
      return true;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return true; // No auth needed for local
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    // Option A: Use Claude SDK with ANTHROPIC_BASE_URL pointed at LiteLLM
    // Option B: Use OpenAI SDK directly with Ollama endpoint
    // Sessions persist to same JSONL format either way
  }
}
```

## Why Local Models?

| Benefit | Cloud APIs | Local Models |
|---------|------------|--------------|
| Cost | ~$5-10/M tokens | $0 |
| Privacy | Data leaves machine | Data stays local |
| Latency | 2-5s | <1s |
| Offline | No | Yes |
| Control | Provider decides | You decide |

## Implementation Phases

1. **Phase A:** Set up Ollama + LiteLLM locally, test with existing code
2. **Phase B:** Create `LocalModelProvider` class
3. **Phase C:** Add UI toggle for local vs cloud
4. **Phase D:** Document setup for users

## LiteLLM Configuration

```yaml
# litellm/config.yaml
model_list:
  - model_name: qwen-local
    litellm_params:
      model: ollama/qwen2.5-coder:32b
      api_base: http://localhost:11434/v1
      api_key: "not-needed"

  - model_name: devstral-local
    litellm_params:
      model: ollama/devstral:15b
      api_base: http://localhost:11434/v1
```

## Related Documents

- [Multi-Provider Integration Plan](../tasks/multi-provider-integration.md)
- [Multi-Provider Executive Summary](../tasks/multi-provider-executive-summary.md)
- [Cross-Provider Subagents](./cross-provider-subagents.md)
