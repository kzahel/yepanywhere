# Cross-Provider Subagents

## Overview

Enable agents to spawn subagents using different providers. Initial scope: Claude can launch Codex or Gemini as subagents.

## Approach

Inject a custom tool into Claude at startup that calls back to our supervisor:

```typescript
{
  name: "spawn_subagent",
  description: "Spawn a subagent with a different AI provider",
  parameters: {
    provider: "codex" | "gemini",
    prompt: string,
    waitForResult: boolean
  }
}
```

**Flow:**
1. Claude calls `spawn_subagent({ provider: "codex", prompt: "..." })`
2. Our `canUseTool` handler intercepts this
3. Supervisor spawns a Codex session (child linked to parent)
4. Results stream back to Claude as tool result
5. All sessions tracked by our supervisor

## Why This Approach

- **Unified visibility**: All sessions go through our supervisor
- **Consistent persistence**: We control session storage/linking
- **Permission model**: Our approval flow applies to subagent spawning
- **Simple start**: Only need to inject tool into Claude SDK (which we control)

## Alternative Approaches (Deferred)

1. **MCP Server**: Expose supervisor as MCP server that any agent can call
2. **Bidirectional**: All providers can spawn all other providers
3. **Direct CLI**: Agents shell out to each other (loses visibility)

## Session Linking

Track parent-child relationships:

```typescript
interface SessionMetadata {
  parentSessionId?: string;
  childSessionIds?: string[];
  provider: 'claude' | 'codex' | 'gemini';
}
```

## Prerequisites

- Multi-provider support (Phases 1-4 of integration plan)
- Tool injection into Claude SDK
- Session metadata for parent/child linking

## Status

Planned for after basic multi-provider integration is complete.
