# VS Code Claude UI Visual Specification

> **Purpose**: This document serves as the authoritative visual reference for making claude-anywhere's message rendering match VS Code's Claude Code extension. Include this file in context when working on renderers.

**Companion Document**: See [claude-vscode-style-guide.md](../project/claude-vscode-style-guide.md) for comprehensive design tokens and component catalog.

**Source**: Values extracted from `claude-vscode-extension/` (HTML, CSS, screenshots)

---

## Color Palette

Extracted from the Claude Code VSCode extension CSS:

```css
/* Claude Brand Colors */
--app-claude-orange: #d97757;      /* Primary accent, timeline dots */
--app-claude-clay-button-orange: #c6613f; /* Light theme accent */
--app-claude-ivory: #faf9f5;       /* Light backgrounds */
--app-claude-slate: #141413;       /* Dark backgrounds */

/* Timeline Dot Colors (from .o:before variants) */
--timeline-dot-default: var(--vscode-descriptionForeground); /* Gray for text */
--timeline-dot-tool: #74c991;      /* Green for tool calls (.o.rr) */
--timeline-dot-error: #c74e39;     /* Red for errors (.o.ir) */
--timeline-dot-warning: #e1c08d;   /* Amber for warnings (.o.tr) */
--timeline-line: var(--app-primary-border-color); /* Vertical connector */

/* Text Colors */
--text-primary: var(--vscode-foreground);           /* #cccccc */
--text-muted: var(--vscode-descriptionForeground);  /* #9d9d9d */
--text-dimmed: #666666;

/* Background Colors */
--bg-surface: var(--vscode-sideBar-background);     /* #181818 */
--bg-hover: var(--vscode-list-hoverBackground);     /* #2a2d2e */
--bg-code: var(--vscode-editor-background);         /* #1f1f1f */

/* Semantic Colors */
--link-color: #4daafc;             /* Links, clickable filenames */
--error-color: #c74e39;            /* Errors, deletions */
--success-color: #74c991;          /* Success, additions */
--warning-color: #e1c08d;          /* Warnings, modified */
```

---

## Timeline Structure

The left-side timeline with status dots. Each message/tool call gets an orange dot aligned vertically.

### Visual Reference
```
┌─────────────────────────────────────────────────────────────┐
│ ●   Let me look at the ReadRenderer...                      │
│ ●   Thinking ▸                                              │
│ ●   Read  ReadRenderer.tsx                                  │
│ ●   Thinking ▸                                              │
│ ●   Grep  "tool_use|tool_result" (glob: **/types*.ts)      │
│ ●   Glob pattern: "**/*MessageRenderer*.tsx"                │
│         No files found                                       │
│ ●   Thinking ▸                                              │
│ ●   Read  types.ts                                          │
└─────────────────────────────────────────────────────────────┘
  ↑
  GREEN dots for tool calls (#74c991)
  Gray for text messages
  Red for errors, amber for warnings
```

### CSS/Layout
```css
/* Semantic naming (minified: .V) */
.message-row {
  display: flex;
  align-items: flex-start;
  padding: 8px 0;
  gap: 8px;
}

/* Timeline dot - uses ::before pseudo-element with Unicode circle */
/* Minified: .o:before */
.message-row::before {
  content: "\25cf";  /* ● Unicode filled circle */
  position: absolute;
  left: 8px;
  padding-top: 2px;
  font-size: 10px;
  color: var(--app-secondary-foreground); /* Default: gray */
}

/* Tool call dots are GREEN */
.message-row--tool::before {
  color: #74c991;  /* Green */
}

/* Error dots are RED */
.message-row--error::before {
  color: #c74e39;  /* Red */
}

/* Warning dots are AMBER */
.message-row--warning::before {
  color: #e1c08d;  /* Amber */
}

/* Working/loading state uses orange spinner */
.message-row--working::before {
  color: var(--app-spinner-foreground); /* #d97757 orange */
  animation: codicon-spin 1s linear infinite;
}
```

---

## Tool Call Row (Collapsed)

Single-line compact display of a tool operation. Uses collapsible `<details>` pattern.

### Visual Reference
```
┌─────────────────────────────────────────────────────────┐
│ ● Read  types.ts                                        │
│ ● Grep  "pattern" (glob: **/*.ts)                       │
│         4 lines of output                               │
│ ● Glob pattern: "**/*.tsx"                              │
│         Found 2 files                                   │
│ ● Bash  pnpm typecheck && pnpm lint                     │
└─────────────────────────────────────────────────────────┘
  ↑       ↑                ↑
  dot     tool name        parameters (monospace)
          (bold)           result count (muted)
```

### Structure (Semantic Names)
```tsx
{/* Minified: .V.o.rr > .Ut > .xr > summary.fr */}
<div className="message-row message-row--tool">
  <div className="tool-container">
    <div className="tool-inner">
      <summary className="tool-summary">
        <span className="tool-name">Read</span>
        <span className="tool-description">types.ts</span>
      </summary>
      {/* Expanded content goes here */}
    </div>
  </div>
</div>
```

### CSS
```css
/* Minified: .V.o.rr */
.message-row--tool {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

/* Minified: .vr */
.tool-name {
  font-weight: 700;
  font-size: 13px;
  color: var(--vscode-foreground);
}

/* Minified: .O */
.tool-description {
  font-family: var(--app-monospace-font-family);
  font-size: 13px;
  color: var(--link-color); /* #4daafc for filenames */
}

/* Result count (muted text below) */
.tool-result-count {
  font-size: 12px;
  color: var(--text-muted);
  padding-left: 16px; /* Indent under tool name */
}
```

---

## Tool Call Row (Expanded)

When user clicks to expand a tool call. Uses `<details>` with `.code-block` for content.

### Visual Reference
```
┌─────────────────────────────────────────────────────────┐
│ ● Task: Find settings and test files                    │
│   ┌───────────────────────────────────────────────────┐ │
│   │ IN   I need to find files related to:             │ │
│   │      1. Settings configuration                    │ │
│   │      2. Test files for the feature                │ │
│   ├───────────────────────────────────────────────────┤ │
│   │ OUT  Found 3 relevant files:                      │ │
│   │      - src/settings.ts                            │ │
│   │      - tests/settings.test.ts                     │ │
│   └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Structure
```tsx
{/* Minified: .kr > .yr > .bo */}
<div className="code-block">
  <div className="code-block__grid">
    <div className="code-block__row">
      <div className="code-block__label">IN</div>
      <div className="code-block__value">
        <pre>{inputContent}</pre>
      </div>
    </div>
    <div className="code-block__row">
      <div className="code-block__label">OUT</div>
      <div className="code-block__value">
        <pre>{outputContent}</pre>
      </div>
    </div>
  </div>
</div>
```

### CSS
```css
/* Minified: .kr */
.code-block {
  background: var(--app-tool-background);
  border: 1px solid var(--app-input-border);
  border-radius: var(--corner-radius-medium); /* 6px */
  overflow: hidden;
}

/* Minified: .yr */
.code-block__grid {
  display: grid;
}

/* Minified: .bo */
.code-block__row {
  display: flex;
  gap: 8px;
}

/* Minified: .zr */
.code-block__label {
  font-family: var(--app-monospace-font-family);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  min-width: 32px;
  padding: 8px;
}

/* Minified: .b */
.code-block__value {
  flex: 1;
  font-family: var(--app-monospace-font-family);
  font-size: 12px;
  padding: 8px;
  overflow-x: auto;
}
```

### Per-Tool Expanded Content

| Tool | IN Content | OUT Content |
|------|------------|-------------|
| **Read** | File path | File contents with line numbers |
| **Bash** | Command | stdout/stderr output |
| **Edit** | File path, changes | Diff preview |
| **Glob** | Pattern | File list |
| **Grep** | Pattern, glob | Matches with context |
| **Task** | Agent prompt | Agent response |

---

## Thinking Block

Claude's internal reasoning, collapsed by default. Uses `<details>` element.

### Visual Reference
```
Collapsed:
┌─────────────────────────────────────────────────────────┐
│ ● Thinking ▸                                            │
└─────────────────────────────────────────────────────────┘

Expanded:
┌─────────────────────────────────────────────────────────┐
│ ● Thinking ▾                                            │
│   Let me look at the ReadRenderer and understand the    │
│   message structure...                                   │
└─────────────────────────────────────────────────────────┘
```

### Structure
```tsx
{/* Minified: .Kt > .M + .Qt */}
<details className="collapsible">
  <summary className="collapsible__summary">
    <span>Thinking</span>
    <span className="collapsible__icon">▸</span>
  </summary>
  <div className="collapsible__content">
    <span className="text-content">
      {thinkingContent}
    </span>
  </div>
</details>
```

### CSS
```css
/* Minified: .Kt */
.collapsible {
  /* Wrapper for collapsible content */
}

/* Minified: .M */
.collapsible__summary {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  list-style: none; /* Remove default marker */
}

.collapsible__summary::-webkit-details-marker {
  display: none;
}

/* Minified: .Jt */
.collapsible__icon {
  font-size: 10px;
  transition: transform 0.15s ease;
}

details[open] .collapsible__icon {
  transform: rotate(90deg);
}

/* Minified: .Qt */
.collapsible__content {
  padding: 8px 0 8px 16px;
}

/* Minified: .e */
.text-content {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}
```

---

## Text/Assistant Message

Claude's conversational responses. Renders markdown with proper styling.

### Visual Reference
```
┌─────────────────────────────────────────────────────────┐
│ ● I've analyzed the codebase and created the plan.      │
│   Here's a summary:                                     │
│                                                          │
│   • Problem statement - why two blocks is suboptimal    │
│   • Current architecture - how messages flow            │
│   • 4 solution options with pros/cons                   │
│                                                          │
│   The implementation is minimal - just adding a health  │
│   check mechanism for robustness.                       │
└─────────────────────────────────────────────────────────┘
```

### Structure
```tsx
{/* Minified: .V.o > .e */}
<div className="message-row message-row--assistant">
  <span className="text-content">
    <p>I've analyzed the codebase...</p>
    <ul>
      <li>Problem statement...</li>
    </ul>
  </span>
</div>
```

### CSS
```css
/* Minified: .V.o */
.message-row--assistant {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

/* Minified: .e */
.text-content {
  font-size: 13px;
  line-height: 1.5;
  color: var(--vscode-foreground);
}

.text-content p {
  margin: 0 0 8px 0;
}

.text-content code {
  font-family: var(--app-monospace-font-family);
  font-size: .9em;
  background: var(--vscode-textPreformat-background);
  color: var(--vscode-textPreformat-foreground);
  padding: 2px 4px;
  border-radius: 4px;
}

.text-content pre {
  background: var(--app-tool-background);
  border: 1px solid var(--app-input-border);
  border-radius: var(--corner-radius-medium);
  padding: 8px;
  overflow-x: auto;
}

.text-content ul, .text-content ol {
  margin: 8px 0;
  padding-left: 24px;
}
```

---

## Streaming/Loading States

### Tool In Progress
Uses VSCode codicon spinner animation with Claude orange color.

```css
/* Spinner color */
.spinner {
  color: var(--app-spinner-foreground); /* #d97757 dark, #c6613f light */
  animation: codicon-spin 1.5s linear infinite;
}

@keyframes codicon-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

### Thinking In Progress
Shows "Thinking" label with animated indicator.

```css
.thinking-in-progress {
  color: var(--text-muted);
  font-size: 13px;
}

.thinking-in-progress::after {
  content: '...';
  animation: ellipsis 1.5s infinite;
}
```

---

## Typography

Extracted from extension CSS:

```css
:root {
  /* Font families - use VSCode variables for theme consistency */
  --font-sans: var(--vscode-chat-font-family,
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif);
  --font-mono: var(--vscode-editor-font-family,
    'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace);
  /* Also available as: */
  --app-monospace-font-family: var(--vscode-editor-font-family, monospace);

  /* Font sizes */
  --font-size-xs: 10px;
  --font-size-sm: 12px;   /* Monospace/code default */
  --font-size-base: 13px; /* UI text default (--vscode-chat-font-size) */
  --font-size-lg: 14px;

  /* Relative sizes used in extension */
  /* .85em, .9em, .95em, 1em */

  /* Font weights */
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  /* Line heights */
  --line-height-tight: 1.2;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.6;
}
```

---

## Spacing Scale

Extracted from extension CSS variables:

```css
:root {
  /* App spacing tokens */
  --app-spacing-small: 4px;
  --app-spacing-medium: 8px;
  --app-spacing-large: 12px;
  --app-spacing-xlarge: 16px;

  /* Semantic aliases */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;

  /* Common padding patterns */
  --list-item-padding: 4px 8px;
  --button-padding: 6px 8px;
  --code-block-padding: 8px;

  /* Border radius */
  --corner-radius-small: 4px;
  --corner-radius-medium: 6px;
  --corner-radius-large: 8px;
  --app-list-border-radius: 4px;
}
```

---

## Reference: Extracted Extension Files

Source files in `claude-vscode-extension/`:
- `index.html` - HTML structure (2,105 lines)
- `index.css` - Minified CSS with all styles
- `index.jsonl` - Sample conversation data
- `*.png` - Visual reference screenshots

See also:
- [claude-vscode-style-guide.md](../project/claude-vscode-style-guide.md) - Complete design tokens and component catalog
- [claude-message-format-enhanced.md](../research/claude-message-format-enhanced.md) - JSONL message format documentation

### Cline Source Code (open-source reference)

The open-source Cline extension has similar UI patterns:
- `webview-ui/src/components/chat/ChatRow.tsx` - Main message row component
- `webview-ui/src/index.css` - Theme variables and base styles
- GitHub: https://github.com/cline/cline

---

## Class Name Reference

Quick lookup for minified → semantic names:

| Minified | Semantic | Usage |
|----------|----------|-------|
| `.Ve` | `.app-container` | Root wrapper |
| `.V` | `.message-row` | Message container |
| `.V.o` | `.message-row--assistant` | Assistant msg |
| `.V.o.rr` | `.message-row--tool` | Tool call msg |
| `.Kt` | `.collapsible` | Expandable wrapper |
| `.M` | `.collapsible__summary` | Summary header |
| `.Qt` | `.collapsible__content` | Hidden content |
| `.vr` | `.tool-name` | Tool name (bold) |
| `.O` | `.tool-description` | Tool params |
| `.kr` | `.code-block` | Code container |
| `.yr` | `.code-block__grid` | Code grid |
| `.zr` | `.code-block__label` | IN/OUT label |
| `.b` | `.code-block__value` | Code value |
| `.e` | `.text-content` | Prose text |

---

## Checklist for Implementation

### Core Components
- [x] Color palette extracted
- [x] Typography tokens extracted
- [x] Spacing scale extracted
- [ ] Timeline dots (green for tools, gray default, red/amber for states)
- [ ] Message row layout

### Tool Renderers
- [ ] Collapsed tool row with summary
- [ ] Expand/collapse animation (details element)
- [ ] Read tool: filename + expandable content
- [ ] Bash tool: command + output sections
- [ ] Grep tool: pattern + match count + results
- [x] Edit tool: filename + diff preview
- [ ] Glob tool: pattern + file list
- [ ] Task tool: prompt + response

### Content Blocks
- [ ] Thinking: collapsible with chevron
- [ ] Text: markdown with code highlighting
- [ ] Code blocks with IN/OUT labels

### States
- [ ] Loading spinner (Claude orange)
- [ ] Streaming text
- [ ] Error states
