# SDK Schema Testing Infrastructure

## Problem

Our SDK message types (`SDKMessage`, `RawSessionMessage`, etc.) are largely guesswork based on observation. We discovered during the attachment fix that the SDK doesn't echo user messages via the stream - they're written directly to JSONL. There are likely other undocumented behaviors and schema variations we're not handling correctly.

## Goals

1. **Validate our types** against real SDK output
2. **Detect schema changes** when Claude CLI updates
3. **Document actual message formats** for different scenarios
4. **Catch parsing bugs** before they hit production

## Proposed Approach

### 1. Collect JSONL Samples

Leverage existing local sessions from `~/.claude/projects/*/`:

```bash
# Find all JSONL files
find ~/.claude/projects -name "*.jsonl" -type f

# Collect diverse samples covering different scenarios
```

Scenarios to capture:
- Simple text conversation
- Tool use (Read, Write, Edit, Bash, etc.)
- Tool approval flow (default permission mode)
- Multi-turn with context
- Errors and failures
- Abort/interruption
- Images/attachments
- Subagents (Task tool)
- Plan mode (EnterPlanMode, ExitPlanMode)
- Input requests (AskUserQuestion, tool approval prompts)

### 2. Zod Schema Definitions

Create strict Zod schemas that match our TypeScript types:

```typescript
// packages/server/src/sdk/schemas.ts
import { z } from "zod";

// Base message schema
const BaseMessageSchema = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(),
});

// User message schema
const UserMessageSchema = BaseMessageSchema.extend({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
  }),
  userType: z.enum(["external", "internal"]).optional(),
  isSidechain: z.boolean().optional(),
});

// Assistant message schema
const AssistantMessageSchema = BaseMessageSchema.extend({
  type: z.literal("assistant"),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(ContentBlockSchema),
    model: z.string().optional(),
    usage: UsageSchema.optional(),
  }),
});

// System init message schema
const SystemInitSchema = BaseMessageSchema.extend({
  type: z.literal("system"),
  subtype: z.literal("init"),
  cwd: z.string(),
  session_id: z.string(),
  tools: z.array(z.string()),
  model: z.string(),
  permissionMode: z.string(),
  // ... other fields
});

// Result message schema
const ResultSchema = BaseMessageSchema.extend({
  type: z.literal("result"),
  subtype: z.enum(["success", "error"]),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  // ...
});

// Union of all message types
export const SDKMessageSchema = z.discriminatedUnion("type", [
  UserMessageSchema,
  AssistantMessageSchema,
  SystemInitSchema,
  ResultSchema,
  // ... other message types
]);
```

### 3. Test Structure

```
packages/server/
├── test/
│   └── e2e/
│       ├── real-sdk.e2e.test.ts      # Existing E2E tests
│       ├── schemas/
│       │   ├── fixtures/              # Captured JSONL samples
│       │   │   ├── simple-chat.jsonl
│       │   │   ├── tool-use-read.jsonl
│       │   │   ├── tool-approval.jsonl
│       │   │   ├── multi-turn.jsonl
│       │   │   ├── error-cases.jsonl
│       │   │   └── ...
│       │   ├── schema.test.ts         # Validate fixtures against Zod
│       │   └── capture.ts             # Script to capture new fixtures
│       └── sdk-contract.e2e.test.ts   # Contract tests (real SDK)
```

### 4. Schema Validation Tests

```typescript
// test/e2e/schemas/schema.test.ts
import { readdirSync, readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { SDKMessageSchema } from "../../../src/sdk/schemas";

describe("SDK Schema Validation", () => {
  const fixturesDir = join(__dirname, "fixtures");
  const fixtures = readdirSync(fixturesDir).filter(f => f.endsWith(".jsonl"));

  for (const fixture of fixtures) {
    describe(fixture, () => {
      const content = readFileSync(join(fixturesDir, fixture), "utf-8");
      const messages = content
        .split("\n")
        .filter(line => line.trim())
        .map(line => JSON.parse(line));

      messages.forEach((msg, i) => {
        it(`message ${i} (${msg.type}) validates against schema`, () => {
          const result = SDKMessageSchema.safeParse(msg);
          if (!result.success) {
            console.log("Failed message:", JSON.stringify(msg, null, 2));
            console.log("Errors:", result.error.format());
          }
          expect(result.success).toBe(true);
        });
      });
    });
  }
});
```

### 5. Fixture Capture Script

```typescript
// test/e2e/schemas/capture.ts
/**
 * Capture JSONL from real SDK sessions for use as test fixtures.
 *
 * Usage:
 *   pnpm tsx test/e2e/schemas/capture.ts <scenario-name> "<prompt>"
 *
 * Examples:
 *   pnpm tsx test/e2e/schemas/capture.ts simple-chat "Say hello"
 *   pnpm tsx test/e2e/schemas/capture.ts tool-use-read "Read package.json"
 */

import { RealClaudeSDK } from "../../../src/sdk/real";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

async function capture(scenarioName: string, prompt: string) {
  const sdk = new RealClaudeSDK();
  const { iterator, abort } = await sdk.startSession({
    cwd: process.cwd(),
    initialMessage: { text: prompt },
    permissionMode: "bypassPermissions",
  });

  const messages = [];
  const timeout = setTimeout(() => abort(), 60000);

  try {
    for await (const message of iterator) {
      messages.push(message);
      if (message.type === "result") break;
    }
  } finally {
    clearTimeout(timeout);
  }

  // Also capture the JSONL file from disk for comparison
  // ...

  const outputPath = join(__dirname, "fixtures", `${scenarioName}.jsonl`);
  mkdirSync(join(__dirname, "fixtures"), { recursive: true });
  writeFileSync(
    outputPath,
    messages.map(m => JSON.stringify(m)).join("\n")
  );

  console.log(`Captured ${messages.length} messages to ${outputPath}`);
}

const [scenarioName, prompt] = process.argv.slice(2);
if (!scenarioName || !prompt) {
  console.error("Usage: capture.ts <scenario-name> \"<prompt>\"");
  process.exit(1);
}

capture(scenarioName, prompt);
```

### 6. SDK Contract Tests

Tests that verify specific SDK behaviors:

```typescript
// test/e2e/sdk-contract.e2e.test.ts
describe("SDK Contract Tests", () => {
  it("user messages appear in JSONL with enriched content", async () => {
    // Verify attachment formatting matches our expectations
  });

  it("tool approval flow produces input_request messages", async () => {
    // Verify the approval flow message sequence
  });

  it("system:init contains expected tool list", async () => {
    // Verify tool names match what we expect
  });

  it("result message contains cost and usage data", async () => {
    // Verify billing data format
  });

  it("parentUuid correctly links message chains", async () => {
    // Verify DAG structure
  });
});
```

### 7. CI Integration

```yaml
# .github/workflows/sdk-schema.yml
name: SDK Schema Tests

on:
  schedule:
    - cron: '0 0 * * *'  # Nightly
  workflow_dispatch:      # Manual trigger

jobs:
  schema-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Claude CLI
        run: curl -fsSL https://claude.ai/install.sh | bash
      - name: Run schema validation
        run: pnpm test:schemas
      - name: Run SDK contract tests
        env:
          REAL_SDK_TESTS: true
        run: pnpm test:e2e:sdk
```

### 8. Leveraging Existing Sessions

Script to extract and anonymize useful samples from local sessions:

```typescript
// scripts/extract-schema-samples.ts
/**
 * Extract diverse message samples from existing local sessions.
 * Anonymizes content while preserving structure.
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";

const claudeDir = join(process.env.HOME!, ".claude", "projects");

function anonymize(message: any): any {
  // Preserve structure, replace sensitive content
  // ...
}

function categorize(messages: any[]): Map<string, any[]> {
  // Group by message type and subtype
  const categories = new Map<string, any[]>();
  for (const msg of messages) {
    const key = msg.subtype ? `${msg.type}:${msg.subtype}` : msg.type;
    if (!categories.has(key)) categories.set(key, []);
    categories.get(key)!.push(msg);
  }
  return categories;
}

// Find sessions with interesting patterns
// Extract representative samples
// Write to fixtures directory
```

## Benefits

1. **Confidence in types**: Know our schemas match reality
2. **Regression detection**: Catch SDK changes early
3. **Documentation**: Fixtures serve as examples
4. **Debugging aid**: Real samples help understand edge cases
5. **Onboarding**: New developers can see real message formats

## Implementation Order

1. [ ] Create Zod schemas for core message types
2. [ ] Extract sample fixtures from existing sessions
3. [ ] Add schema validation tests
4. [ ] Add SDK contract E2E tests
5. [ ] Set up nightly CI job
6. [ ] Add capture script for new scenarios

## Notes

- E2E tests cost money (API calls) - use sparingly
- Cache/record responses where possible
- Consider mock mode for CI that validates against recorded fixtures
- SDK version should be tracked with fixtures for compatibility
