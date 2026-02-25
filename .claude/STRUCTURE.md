# Claude God Mode Directory Structure

This document describes all directories used by Claude God Mode agents. Check these locations for user-provided content and use them for outputs.

## User Context (READ from here)

Users provide brand assets and references in `.claude/context/`. **Check this FIRST before generating designs or asking questions.**

```
.claude/context/
├── brand/                    # Brand guidelines and identity
│   ├── logo.svg              # Company logo (SVG preferred)
│   ├── logo.png              # Logo fallback
│   ├── colors.txt            # Brand colors (hex/RGB)
│   ├── guidelines.pdf        # Full brand style guide
│   └── fonts/                # Custom fonts if any
├── references/               # Design inspiration
│   ├── competitor-*.png      # Competitor screenshots
│   ├── inspiration-*.png     # Designs user likes
│   └── mood-board/           # Visual direction
├── assets/                   # Existing assets to reuse
│   ├── photos/               # Real photos (team, products)
│   └── icons/                # Existing icon set
└── README.md                 # User notes about preferences
```

### Detection Logic

At session start, check for user context:
```bash
if [ -d ".claude/context" ] && [ "$(ls -A .claude/context 2>/dev/null)" ]; then
    # User has provided context - USE IT
    cat .claude/context/README.md 2>/dev/null
    find .claude/context -type f \( -name "*.svg" -o -name "*.png" -o -name "*.txt" \) 2>/dev/null
fi
```

### What to do with User Context

| Content | Action |
|---------|--------|
| `brand/colors.txt` | Extract colors for design system |
| `brand/logo.svg` | Include in headers/footers |
| `brand/guidelines.pdf` | Follow documented rules |
| `references/*.png` | Analyze style for inspiration |
| `assets/photos/` | Use REAL photos, never AI-generated |
| `README.md` | Follow user preferences |

---

## PRD & Requirements

```
.claude/prd/
├── <feature-name>.md         # Active PRD (with YAML frontmatter)
└── archive/                  # Archived PRDs
    └── <timestamp>/          # Grouped by archive date
```

**PRD Format Required:**
```yaml
---
created: 2026-01-25T10:00:00Z
feature: feature-name
status: active
---
```

---

## Mode-Specific Directories

### Interview Mode
- **Reads**: `.claude/context/` for brand assets
- **Writes**: `.claude/prd/<feature>.md`

### Design Mode
```
.claude/design/
├── research/                 # Project-specific design research
│   └── <topic>.md
├── mockups/                  # HTML mockup files (self-contained Tailwind)
│   └── <page>.html
├── concepts/                 # Visual concepts from nano-banana-pro
│   └── concept-*.png
├── screenshots/              # Browser screenshots at breakpoints
│   ├── <page>-desktop.png
│   ├── <page>-tablet.png
│   └── <page>-mobile.png
├── tokens/                   # Design tokens
│   └── tokens.css
└── <feature>-components.md   # Component specifications

~/.claude/design/reference/   # GLOBAL (reusable across projects)
└── <pattern>-reference.md    # Reusable design patterns
```

### Plan Mode
```
.claude/specs/                # Formal specifications
├── <feature>-spec.md
└── api-spec.md

.claude/exploration/          # Codebase analysis
└── exploration.md            # Findings from code review

.claude/architecture/         # Architecture decisions
├── options.md                # Architecture options
└── decision.md               # Final decision

.taskmaster/                  # TaskMaster data
├── tasks/tasks.json          # All tasks (tagged)
├── state.json                # Current tag, branch mapping
├── config.json               # TaskMaster configuration
└── docs/                     # Generated documentation
```

### Build Mode
- **Reads**: `.taskmaster/tasks/tasks.json`
- **Writes**: `.claude/ralph-loop.local.md` (current task context)
- **Uses**: All Plan mode directories

### Test Mode
```
.claude/test-sessions/
├── state.json                # Current test session state
└── screenshots/              # Test screenshots

.claude/test-reports/
├── test-report-*.md          # Test run reports
├── failures.json             # Current failures
└── archive/                  # Archived reports
    └── <timestamp>/

.claude/test-round            # Current test iteration number
```

### Debug Mode
```
~/.claude/fix/                # GLOBAL fix tracking
├── sessions/
│   └── <YYYY-MM-DD_HHMM_slug>/
│       ├── diagnosis.md      # Root cause analysis
│       ├── outcome.md        # Fix result
│       └── changes.patch     # Git diff
└── patterns.md               # Learned fix patterns
```

---

## Session & Workflow State

```
.claude/sessions/
├── current_mode              # Active mode name
├── workflow_source           # Where workflow started
├── worktree_tag              # TaskMaster tag for this worktree
├── worktree_type             # "ephemeral" or permanent
└── transition-context.json   # Full transition metadata
```

---

## Generated/Synced (DO NOT EDIT)

These are auto-synced from `~/Projects/claude-modes/resources/`:

```
.claude/commands/             # Slash commands (synced)
.claude/agents/               # Agent instructions (synced)
.claude/rules/                # Mode rules (synced)
.claude/CLAUDE.md             # Project instructions (synced)
.claude/settings.local.json   # Mode settings (generated)
```

---

## Quick Reference by Mode

| Mode | Read From | Write To |
|------|-----------|----------|
| Interview | `.claude/context/` | `.claude/prd/` |
| Design | `.claude/context/`, `.claude/prd/` | `.claude/design/` |
| Plan | `.claude/prd/`, `.claude/design/` | `.claude/specs/`, `.claude/exploration/`, `.claude/architecture/`, `.taskmaster/` |
| Build | `.taskmaster/`, `.claude/specs/` | Source code, `.claude/ralph-loop.local.md` |
| Test | Source code | `.claude/test-reports/`, `.claude/test-sessions/` |
| Debug | Source code, logs | `~/.claude/fix/` (global) |
