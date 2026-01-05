# SDK Types Migration: Remaining Work

This document captures pending work from the SDK types migration and related cleanup tasks.

## Background

The SDK types migration (documented in `docs/tasks/sdk-types-migration.md`) moved from loose, manually-defined TypeScript types to Zod-inferred types from `packages/shared/src/claude-sdk-schema/`.

**Completed phases:**
- Phase 1: Export types from shared package
- Phase 2: Define app-specific extended types
- Phase 3: Migrate server types
- Phase 4a-f: Migrate client types

**Key changes made:**
- Server no longer transforms JSONL data (removed `id`, `role`, top-level `content` copies)
- Client uses `getMessageId()` helper for `uuid ?? id` fallback
- Client code prefers `message.content` over top-level `content`
- Client uses `type` field for discrimination instead of `role`

---

## Priority 1: Fix Client Type Discrepancy

### Issue

Phase 4d removed the `id` assignment from `SessionReader.convertMessage()`, but the client `Message` interface still:
1. Has `id: string` as **required**
2. Documents that "server's SessionReader.convertMessage() always adds `id`" (now incorrect)

### Files to Update

**`packages/client/src/types.ts`** - Update Message interface:
```typescript
export interface Message {
  /** SDK message identifier (primary identifier) */
  uuid?: string;
  /** Legacy id field - may not be present for new messages */
  id?: string;  // Change from required to optional
  // ... rest unchanged
}
```

Update the documentation comment to reflect that `id` is no longer guaranteed.

### Impact Assessment

The `getMessageId()` helper already handles `uuid ?? id`, so most code should work. However, places that access `m.id` directly will need review:
- React keys using `message.id`
- Map/Set operations keyed by `message.id`
- Deduplication logic using `message.id`

Run `grep -r "\.id" packages/client/src` to find direct `id` accesses.

---

## Priority 2: Phase 5 - Cleanup and Documentation

### 2.1 Remove Dead Code

- [ ] Audit `packages/server/src/supervisor/types.ts` for unused type definitions
- [ ] Audit `packages/server/src/sdk/types.ts` for duplicated types
- [ ] Remove any commented-out old type definitions
- [ ] Check for unused imports after type changes

### 2.2 Update Validation Script

- [ ] Verify `scripts/validate-jsonl.ts` still works with current schema
- [ ] Consider adding to CI as a periodic check
- [ ] Document how to run validation in CLAUDE.md

### 2.3 Document the Type System

- [ ] Add overview comments in `packages/shared/src/claude-sdk-schema/index.ts`
- [ ] Update CLAUDE.md with type system documentation
- [ ] Document the `getMessageId()` pattern for new developers

---

## Priority 3: E2E Test Fixes

### Issue

E2E tests are failing due to UI selector mismatches (unrelated to SDK types migration):

- Tests expect `.new-session-form textarea` selector
- `NewSessionForm.tsx` uses different class names (`.new-session-form-compact`, `.new-session-container`)
- This is from a separate UI refactor (file shows as untracked: `??`)

### Resolution Options

1. **Update E2E tests** to use new selectors
2. **Revert UI changes** if the refactor was unintentional
3. **Add data-testid attributes** for more stable selectors

### Files to Review

- `packages/client/src/components/NewSessionForm.tsx` (untracked)
- `packages/client/e2e/*.spec.ts` (multiple failing tests)

---

## Priority 4: Type Alignment Opportunities

These are optional improvements identified during the migration:

### 4.1 Strict AppMessage Usage

The client `Message` interface is intentionally loose for flexibility. Consider creating a strict variant for type-safe code paths:

```typescript
// For code that needs full type safety
type StrictMessage = AppMessage;

// For flexible code (streaming, tests)
interface Message { ... } // current loose interface
```

### 4.2 Server Type Exports

Consider whether the server should export its `Message` type for shared use, or if packages should only depend on shared types.

### 4.3 Content Block Type Hierarchy

Currently:
- `packages/shared/src/app-types.ts` has `AppContentBlock` (loose)
- `packages/client/src/components/renderers/types.ts` has `ContentBlock` (strict for rendering)

This is intentional but could benefit from documentation explaining the pattern.

---

## Testing Checklist

After making changes, verify:

```bash
pnpm typecheck    # TypeScript compilation
pnpm test         # Unit tests
pnpm lint         # Linting
pnpm test:e2e     # E2E tests (after fixing selectors)
```

Manual testing:
- [ ] Load existing sessions with old data format
- [ ] Send new messages
- [ ] Test Task subagent rendering
- [ ] Verify streaming works correctly

---

## Reference: Key Type Locations

| Type | Location | Purpose |
|------|----------|---------|
| `SessionEntry` | `shared/claude-sdk-schema/` | Raw JSONL entry types |
| `AppMessage` | `shared/app-types.ts` | SDK entry + app extensions |
| `Message` | `client/src/types.ts` | Loose client interface |
| `Message` (server) | `server/supervisor/types.ts` | Server JSONL pass-through |
| `ContentBlock` | `client/components/renderers/types.ts` | Strict rendering type |
| `AppContentBlock` | `shared/app-types.ts` | Loose content block |

---

## Historical Context

The original migration was motivated by:
1. **Schema drift** - Manual types diverged from actual JSONL format
2. **Duplicate definitions** - Types defined in multiple places
3. **Poor type safety** - Loose types allowed invalid access patterns

The Zod schemas in `claude-sdk-schema/` now serve as the single source of truth, with 99.998% validation pass rate on existing sessions.
