# Claude Anywhere

## Required Reading

This is a new project. Before starting any task, read all files in `docs/project/` to understand the project vision and architecture:

- `docs/project/claude-anywhere-vision.md` - Core vision and goals
- `docs/project/project-vision.md` - Project overview
- `docs/project/security-setup.md` - Security configuration

This ensures all agents have a shared understanding of what we're building.

## After Editing Code

After editing TypeScript or other source files, verify your changes compile and pass checks:

```bash
pnpm lint       # Biome linter
pnpm typecheck  # TypeScript type checking (fast, no emit)
pnpm test       # Unit tests
pnpm test:e2e   # E2E tests (if UI changes)
```

Fix any errors before considering the task complete.

## Git Commits

Never mention Claude, AI, or any AI assistant in commit messages. Write commit messages as if a human developer wrote them.
