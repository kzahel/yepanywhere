# claude-anywhere

## Executive Summary

**claude-anywhere** is a mobile-first supervisor for Claude Code agents. It lets you manage coding sessions running on your development machine from anywhere — your phone, tablet, or laptop — without being tied to a terminal or VS Code window.

Run agents on your Mac Mini. Approve tool requests from your lock screen. Keep working on your projects while pushing your kid on a swing.

### The Pitch

> Supervise Claude Code from anywhere.
> 
> Run coding agents on your dev machine. Approve from your phone.
> No accounts. No cloud. Just download and run.

---

## The Problem

### Current Claude Code Workflows Are Desk-Bound

The existing tools assume you're sitting at a computer with full attention:

| Tool | Limitation |
|------|------------|
| Claude Code CLI | Single session, single terminal, requires active attention |
| VS Code Extension | Tied to VS Code, tunnel reconnects break state, tiny approval indicators |
| Claude Desktop | Chat only, no agentic coding capability |

There's no way to supervise agents from your phone. No push notifications. No glanceable dashboard.

### Multi-Session Management Is Painful

Managing multiple Claude sessions means:
- Four VS Code windows open
- Manually cycling through Cmd+Tab to check for approvals
- Tiny blue dots in tab titles as the only feedback
- Missing approval requests for 20+ minutes because you were focused elsewhere

This barely works on a large monitor. It's unusable on a laptop.

### Dev Work Excludes the Rest of Your Life

Traditional development requires uninterrupted focus blocks at a desk. That's incompatible with:
- Parenting (especially young kids)
- Moving around during the day
- Any situation where you have 30-second windows, not 2-hour blocks

---

## The Solution

### Server-Owned Agent Processes

The server owns the Claude process lifecycle, not the client:

```
SDK async iterator ──► SSE ──► Client (real-time)
        │
        └──► jsonl (persistence)
```

- Client disconnects don't interrupt Claude's work
- Reconnect anytime, pick up where you left off
- Queue messages while Claude is still working

### Glanceable Multi-Project Dashboard

```
┌─────────────────────────────────────────────────────────┐
│  claude-anywhere                                         │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐        │
│  │ backend     │ │ frontend    │ │ docs        │        │
│  │ ● working   │ │ ● awaiting  │ │ ○ idle      │        │
│  │             │ │   approval  │ │             │        │
│  │ Adding auth │ │ [Approve]   │ │             │        │
│  │ middleware  │ │ npm install │ │             │        │
│  └─────────────┘ └─────────────┘ └─────────────┘        │
│                                                          │
│  [+ New Session]                                         │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

One view. All projects. No window cycling.

### True Mobile Supervision

Voice a command while walking around. Get a push notification when approval is needed. Tap approve from your lock screen. Never break flow.

---

## Technical Architecture

### Hybrid Notification System

The core insight: use the right channel for each situation.

```
┌─────────────────────────────────────────────────────────┐
│                      SERVER                              │
├─────────────────────────────────────────────────────────┤
│                                                          │
│   Session Activity ──┬──► SSE Stream (always available) │
│                      │                                   │
│                      └──► Web Push (when needed)         │
│                                                          │
└─────────────────────────────────────────────────────────┘
                           │
            ┌──────────────┴──────────────┐
            ▼                              ▼
    ┌──────────────┐              ┌──────────────┐
    │  App Open    │              │ App Closed/  │
    │  (Foreground)│              │ Background   │
    ├──────────────┤              ├──────────────┤
    │ SSE active   │              │ SSE dead     │
    │ Push ignored │              │ Push wakes   │
    └──────────────┘              └──────────────┘
```

| State | Behavior |
|-------|----------|
| App open, watching session | SSE delivers inline "Approve?" UI, no system notification |
| App open, different view | SSE updates badges, optional in-app toast |
| App backgrounded | Push notification with action buttons |
| Phone in pocket, screen off | Push notification, approve from lock screen |

### Web Push Without Firebase

A key architectural decision: **no external service dependencies**.

Web Push is a W3C standard. VAPID keys are generated locally — no Google account, no Firebase console, no API quotas.

```bash
# Generate keys locally
npx web-push generate-vapid-keys
```

```typescript
// Server-side push (Node.js)
import webPush from 'web-push';

webPush.setVapidDetails(
  'mailto:you@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

await webPush.sendNotification(subscription, JSON.stringify({
  title: 'Approval needed',
  body: 'Claude wants to run: npm install',
  sessionId: 'abc123'
}));
```

How it works:
- Android/Chrome uses Google's push infrastructure
- Firefox uses Mozilla's
- Safari uses Apple's
- You talk to all of them the same way with VAPID
- Google can't read your payloads — they're end-to-end encrypted
- No accounts, no dashboards, no API keys to rotate

### Notification Decision Logic

```typescript
async function notifyApprovalNeeded(userId: string, session: Session) {
  const client = connectedClients.get(userId);
  
  // Always send through SSE if connected
  if (client) {
    client.stream.send({ type: 'approval_needed', session });
  }
  
  // Also send push if client seems inactive
  const seemsInactive = !client || 
    (Date.now() - client.lastSeen > 30_000);
  
  if (seemsInactive) {
    await sendWebPush(userId, {
      title: 'Approval needed',
      body: `${session.project}: ${truncate(toolRequest)}`,
      data: { sessionId: session.id }
    });
  }
}
```

### Service Worker Push Handling

```typescript
self.addEventListener('push', (event) => {
  const data = event.data.json();
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Skip notification if app is focused (SSE already handled it)
        if (windowClients.some(c => c.focused)) return;
        
        return self.registration.showNotification(data.title, {
          body: data.body,
          data: data.data,
          actions: [
            { action: 'approve', title: 'Approve' },
            { action: 'deny', title: 'Deny' }
          ]
        });
      })
  );
});

self.addEventListener('notificationclick', (event) => {
  const { action } = event;
  const { sessionId } = event.notification.data;
  
  if (action === 'approve' || action === 'deny') {
    // Execute directly without opening app
    event.waitUntil(
      fetch(`/api/sessions/${sessionId}/${action}`, { method: 'POST' })
    );
  }
  event.notification.close();
});
```

---

## Zero External Dependencies

| Concern | Solution | External account? |
|---------|----------|-------------------|
| Server hosting | User's own machine | No |
| Network access | Tailscale (optional) | Already have it |
| Claude API | Claude Code SDK | Already authenticated locally |
| Push notifications | VAPID/Web Push | No |
| Data storage | Local filesystem (jsonl) | No |
| Auth | Tailscale or local-only | No |

This is genuinely clone-and-run. No Firebase project. No OAuth app registration. No API keys from external dashboards.

---

## Future: Native Installer

### Vision

A standalone installer for non-technical users:

```
┌─────────────────────────────────────────────────────────┐
│           claude-anywhere.app                            │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Bundled:                                                │
│  - Node.js runtime                                       │
│  - claude-anywhere server                                │
│  - Claude Code SDK (or defer to system installation)    │
│  - Auto-generated VAPID keys                             │
│                                                          │
│  On first launch:                                        │
│  1. "Login with Claude" (OAuth)                          │
│  2. Pick your projects directory                         │
│  3. Done - service runs in background                    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Installation Principles

**Userland only — no admin/sudo required:**

```
~/.claude-anywhere/
├── bin/
│   └── claude-anywhere    # bundled executable
├── config.json            # settings, VAPID keys
├── subscriptions.json     # push subscriptions
└── logs/
```

**Prefer system Claude CLI, fall back to bundled:**

```typescript
function findClaudeCLI(): string {
  try {
    const systemPath = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (systemPath) return systemPath;
  } catch {}
  return path.join(__dirname, 'vendor', 'claude');
}
```

**Simple install scripts:**

```bash
# macOS / Linux
curl -fsSL https://claude-anywhere.dev/install.sh | sh

# First run
claude-anywhere setup   # OAuth flow, picks projects dir
claude-anywhere start   # Opens browser, ready to go
```

**Complete uninstall:**

```bash
rm -rf ~/.claude-anywhere
```

### Developer Setup (Current)

For users comfortable with git and npm:

```bash
git clone https://github.com/you/claude-anywhere
cd claude-anywhere
npm install
npm run setup    # generates VAPID keys, creates .env
npm run dev      # starts server
```

---

## Competitive Landscape

| Tool | Multi-agent | Desktop | Mobile | Easy Install | No External Deps |
|------|-------------|---------|--------|--------------|------------------|
| Claude Code CLI | ✗ | ✓ | ✗ | ✓ | ✓ |
| VS Code Extension | ✗ | ✓ | ✗ | ✓ | ✓ |
| Google Antigravity | ✓ | ✓ | ✗ | Partial | ✗ |
| Cursor/Windsurf | ✗ | ✓ | ✗ | ✓ | ✓ |
| **claude-anywhere** | ✓ | ✓ | ✓ | ✓ | ✓ |

The unique position: **mobile-first + zero external dependencies + multi-agent oversight**.

---

## Use Cases

### The Parent Developer

> You're watching your kids at the park. You voice a message: "Add pagination to the sessions API." 
> 
> Ten minutes later, your phone buzzes. "Approve: install tanstack-query?" 
> 
> You tap approve without taking your eyes off the playground. Claude continues working.

### The Multi-Project Manager

> You have four projects in flight. Instead of cycling through VS Code windows hoping to spot a blue dot, you glance at one dashboard.
> 
> Backend is working. Frontend needs approval. Docs is idle. One view, everything visible.

### The Laptop Worker

> You don't have a six-monitor command center. You have a 14" MacBook screen.
> 
> One browser tab with the claude-anywhere dashboard. Notifications when you need to act. No window management.

---

## Summary

claude-anywhere fills a gap in the AI coding tool landscape: **supervision from anywhere**.

The technical foundation — server-owned processes, hybrid SSE/Web Push notifications, zero external dependencies — enables a workflow that doesn't exist today.

The vision — download, run, supervise from your phone — makes agentic coding accessible outside the desk-bound terminal workflow.

Build it for yourself. Package it for everyone.
