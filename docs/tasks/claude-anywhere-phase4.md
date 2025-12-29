# Phase 4: Minimal Working UI

## Goal

A functional browser UI where you can browse projects, start/resume sessions, send messages, and watch Claude respond in real-time. Refresh-safe via URL routing.

## Routes

```
/                           → redirect to /projects
/projects                   → project list
/projects/:projectId        → session list for project
/projects/:projectId/sessions/:sessionId  → chat view
```

## Dependencies

```bash
pnpm --filter client add react-router-dom
pnpm --filter client add -D @types/react-router-dom @playwright/test
pnpm --filter client exec playwright install chromium
```

Using react-router v6 — it's familiar, stable, and sufficient.

## File Structure

```
packages/client/
├── e2e/
│   ├── navigation.spec.ts
│   ├── session.spec.ts
│   └── reconnect.spec.ts
├── playwright.config.ts
├── src/
│   ├── main.tsx                 # Router setup
│   ├── App.tsx                  # Delete or keep as layout wrapper
│   ├── types.ts                 # Shared types
│   ├── api/
│   │   └── client.ts            # Fetch helpers
│   ├── hooks/
│   │   ├── useProjects.ts       # GET /api/projects
│   │   ├── useSessions.ts       # GET /api/projects/:id/sessions
│   │   ├── useSession.ts        # GET session + SSE subscription
│   │   └── useSSE.ts            # Generic SSE hook
│   ├── pages/
│   │   ├── ProjectsPage.tsx     # List all projects
│   │   ├── SessionsPage.tsx     # List sessions for a project
│   │   └── ChatPage.tsx         # Main chat interface
│   ├── components/
│   │   ├── MessageList.tsx      # Renders messages
│   │   ├── MessageInput.tsx     # Text input + send button
│   │   └── StatusIndicator.tsx  # Shows process state
│   └── styles/
│       └── index.css            # Minimal CSS
packages/server/src/
├── dev-mock.ts                  # Mock server for e2e tests
└── testing/
    └── mockProjectData.ts       # Creates mock project/session files
```

## Router Setup

```tsx
// packages/client/src/main.tsx

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { SessionsPage } from './pages/SessionsPage';
import { ChatPage } from './pages/ChatPage';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<SessionsPage />} />
        <Route path="/projects/:projectId/sessions/:sessionId" element={<ChatPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
```

## API Client

```typescript
// packages/client/src/api/client.ts

const API_BASE = '/api';

export async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  
  return res.json();
}

export const api = {
  getProjects: () => 
    fetchJSON<{ projects: Project[] }>('/projects'),
  
  getProject: (projectId: string) => 
    fetchJSON<{ project: Project; sessions: SessionSummary[] }>(`/projects/${projectId}`),
  
  getSession: (projectId: string, sessionId: string) =>
    fetchJSON<{ session: Session; messages: Message[]; status: SessionStatus }>(
      `/projects/${projectId}/sessions/${sessionId}`
    ),
  
  startSession: (projectId: string, message: string) =>
    fetchJSON<{ sessionId: string; processId: string }>(
      `/projects/${projectId}/sessions`,
      { method: 'POST', body: JSON.stringify({ message }) }
    ),
  
  resumeSession: (projectId: string, sessionId: string, message: string) =>
    fetchJSON<{ processId: string }>(
      `/projects/${projectId}/sessions/${sessionId}/resume`,
      { method: 'POST', body: JSON.stringify({ message }) }
    ),
  
  queueMessage: (sessionId: string, message: string) =>
    fetchJSON<{ queued: boolean; position: number }>(
      `/sessions/${sessionId}/messages`,
      { method: 'POST', body: JSON.stringify({ message }) }
    ),
  
  abortProcess: (processId: string) =>
    fetchJSON<{ aborted: boolean }>(
      `/processes/${processId}/abort`,
      { method: 'POST' }
    ),
};
```

## SSE Hook

```typescript
// packages/client/src/hooks/useSSE.ts

import { useEffect, useRef, useCallback, useState } from 'react';

interface UseSSEOptions {
  onMessage: (event: MessageEvent) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

export function useSSE(url: string | null, options: UseSSEOptions) {
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  
  const connect = useCallback(() => {
    if (!url) return;
    
    const fullUrl = lastEventIdRef.current 
      ? `${url}?lastEventId=${lastEventIdRef.current}`
      : url;
    
    const es = new EventSource(fullUrl);
    
    es.onopen = () => {
      setConnected(true);
      options.onOpen?.();
    };
    
    es.onmessage = (event) => {
      if (event.lastEventId) {
        lastEventIdRef.current = event.lastEventId;
      }
      options.onMessage(event);
    };
    
    es.onerror = (error) => {
      setConnected(false);
      options.onError?.(error);
      
      // Auto-reconnect after 2s
      es.close();
      setTimeout(connect, 2000);
    };
    
    eventSourceRef.current = es;
  }, [url, options]);
  
  useEffect(() => {
    connect();
    
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connect]);
  
  return { connected };
}
```

## Session Hook with SSE

```typescript
// packages/client/src/hooks/useSession.ts

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useSSE } from './useSSE';

export function useSession(projectId: string, sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: 'idle' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  // Load initial data
  useEffect(() => {
    setLoading(true);
    api.getSession(projectId, sessionId)
      .then((data) => {
        setMessages(data.messages);
        setStatus(data.status);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [projectId, sessionId]);
  
  // Subscribe to live updates
  const handleSSEMessage = useCallback((event: MessageEvent) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'message') {
      setMessages((prev) => [...prev, data.message]);
    } else if (data.type === 'status') {
      setStatus(data.status);
    }
  }, []);
  
  const { connected } = useSSE(
    status.state !== 'idle' ? `/api/sessions/${sessionId}/stream` : null,
    { onMessage: handleSSEMessage }
  );
  
  return { messages, status, loading, error, connected };
}
```

## Pages

### Projects Page

```tsx
// packages/client/src/pages/ProjectsPage.tsx

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    api.getProjects()
      .then((data) => setProjects(data.projects))
      .finally(() => setLoading(false));
  }, []);
  
  if (loading) return <div className="loading">Loading projects...</div>;
  
  return (
    <div className="page">
      <h1>Projects</h1>
      {projects.length === 0 ? (
        <p>No projects found in ~/.claude/projects</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <Link to={`/projects/${project.id}`}>
                <strong>{project.name}</strong>
                <span className="meta">{project.sessionCount} sessions</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Sessions Page

```tsx
// packages/client/src/pages/SessionsPage.tsx

import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

export function SessionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [newMessage, setNewMessage] = useState('');
  const [starting, setStarting] = useState(false);
  
  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId)
      .then((data) => {
        setProject(data.project);
        setSessions(data.sessions);
      })
      .finally(() => setLoading(false));
  }, [projectId]);
  
  const handleStartSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newMessage.trim()) return;
    
    setStarting(true);
    try {
      const { sessionId } = await api.startSession(projectId, newMessage);
      navigate(`/projects/${projectId}/sessions/${sessionId}`);
    } catch (err) {
      console.error('Failed to start session:', err);
      setStarting(false);
    }
  };
  
  if (loading) return <div className="loading">Loading sessions...</div>;
  
  return (
    <div className="page">
      <nav className="breadcrumb">
        <Link to="/projects">Projects</Link> / {project?.name}
      </nav>
      
      <h1>{project?.name}</h1>
      
      <form onSubmit={handleStartSession} className="new-session-form">
        <input
          type="text"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="Start a new session..."
          disabled={starting}
        />
        <button type="submit" disabled={starting || !newMessage.trim()}>
          {starting ? 'Starting...' : 'Start'}
        </button>
      </form>
      
      <h2>Sessions</h2>
      {sessions.length === 0 ? (
        <p>No sessions yet</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link to={`/projects/${projectId}/sessions/${session.id}`}>
                <strong>{session.title || 'Untitled'}</strong>
                <span className="meta">
                  {session.messageCount} messages · {session.status.state}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Chat Page

```tsx
// packages/client/src/pages/ChatPage.tsx

import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { MessageList } from '../components/MessageList';
import { MessageInput } from '../components/MessageInput';
import { StatusIndicator } from '../components/StatusIndicator';
import { api } from '../api/client';

export function ChatPage() {
  const { projectId, sessionId } = useParams<{ projectId: string; sessionId: string }>();
  const { messages, status, loading, error, connected } = useSession(projectId!, sessionId!);
  const [sending, setSending] = useState(false);
  
  const handleSend = async (text: string) => {
    if (!sessionId) return;
    
    setSending(true);
    try {
      if (status.state === 'idle') {
        // Resume the session
        await api.resumeSession(projectId!, sessionId, text);
      } else {
        // Queue to existing process
        await api.queueMessage(sessionId, text);
      }
    } catch (err) {
      console.error('Failed to send:', err);
    } finally {
      setSending(false);
    }
  };
  
  const handleAbort = async () => {
    if (status.state === 'owned' && status.processId) {
      await api.abortProcess(status.processId);
    }
  };
  
  if (loading) return <div className="loading">Loading session...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;
  
  return (
    <div className="chat-page">
      <header className="chat-header">
        <nav className="breadcrumb">
          <Link to="/projects">Projects</Link> / 
          <Link to={`/projects/${projectId}`}>Project</Link> / 
          Session
        </nav>
        <StatusIndicator status={status} connected={connected} onAbort={handleAbort} />
      </header>
      
      <main className="chat-messages">
        <MessageList messages={messages} />
      </main>
      
      <footer className="chat-input">
        <MessageInput 
          onSend={handleSend} 
          disabled={sending}
          placeholder={
            status.state === 'idle' 
              ? 'Send a message to resume...' 
              : 'Queue a message...'
          }
        />
      </footer>
    </div>
  );
}
```

## Components

### MessageList

```tsx
// packages/client/src/components/MessageList.tsx

import { useEffect, useRef } from 'react';

interface Props {
  messages: Message[];
}

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  
  return (
    <div className="message-list">
      {messages.map((msg) => (
        <div key={msg.id} className={`message message-${msg.role}`}>
          <div className="message-role">{msg.role}</div>
          <div className="message-content">
            {typeof msg.content === 'string' 
              ? msg.content 
              : JSON.stringify(msg.content)}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

### MessageInput

```tsx
// packages/client/src/components/MessageInput.tsx

import { useState, KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [text, setText] = useState('');
  
  const handleSubmit = () => {
    if (text.trim() && !disabled) {
      onSend(text.trim());
      setText('');
    }
  };
  
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };
  
  return (
    <div className="message-input">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
      />
      <button onClick={handleSubmit} disabled={disabled || !text.trim()}>
        Send
      </button>
    </div>
  );
}
```

### StatusIndicator

```tsx
// packages/client/src/components/StatusIndicator.tsx

interface Props {
  status: SessionStatus;
  connected: boolean;
  onAbort: () => void;
}

export function StatusIndicator({ status, connected, onAbort }: Props) {
  return (
    <div className="status-indicator">
      <span className={`status-dot status-${status.state}`} />
      <span className="status-text">
        {status.state === 'idle' && 'Idle'}
        {status.state === 'owned' && 'Running'}
        {status.state === 'external' && 'External process'}
      </span>
      {!connected && status.state !== 'idle' && (
        <span className="status-disconnected">Reconnecting...</span>
      )}
      {status.state === 'owned' && (
        <button onClick={onAbort} className="abort-button">
          Stop
        </button>
      )}
    </div>
  );
}
```

## Minimal CSS

```css
/* packages/client/src/styles/index.css */

* {
  box-sizing: border-box;
}

body {
  font-family: system-ui, sans-serif;
  margin: 0;
  padding: 0;
  background: #1a1a1a;
  color: #e0e0e0;
}

.page {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
}

.loading, .error {
  padding: 2rem;
  text-align: center;
}

.breadcrumb {
  font-size: 0.875rem;
  color: #888;
  margin-bottom: 1rem;
}

.breadcrumb a {
  color: #88f;
}

h1 { margin: 0 0 1.5rem; }
h2 { margin: 2rem 0 1rem; }

/* Lists */
.project-list, .session-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.project-list li, .session-list li {
  margin-bottom: 0.5rem;
}

.project-list a, .session-list a {
  display: block;
  padding: 1rem;
  background: #2a2a2a;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
}

.project-list a:hover, .session-list a:hover {
  background: #333;
}

.meta {
  display: block;
  font-size: 0.875rem;
  color: #888;
  margin-top: 0.25rem;
}

/* Forms */
.new-session-form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 2rem;
}

.new-session-form input {
  flex: 1;
  padding: 0.75rem;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 8px;
  color: inherit;
  font-size: 1rem;
}

button {
  padding: 0.75rem 1.5rem;
  background: #4a4aff;
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 1rem;
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: #5a5aff;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Chat page layout */
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.chat-header {
  padding: 1rem;
  border-bottom: 1px solid #333;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.chat-input {
  padding: 1rem;
  border-top: 1px solid #333;
}

/* Messages */
.message {
  margin-bottom: 1rem;
  padding: 1rem;
  border-radius: 8px;
}

.message-user {
  background: #2a3a4a;
  margin-left: 2rem;
}

.message-assistant {
  background: #2a2a2a;
  margin-right: 2rem;
}

.message-system {
  background: #3a3a2a;
  font-size: 0.875rem;
  color: #888;
}

.message-role {
  font-size: 0.75rem;
  font-weight: bold;
  text-transform: uppercase;
  color: #888;
  margin-bottom: 0.5rem;
}

.message-content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* Message input */
.message-input {
  display: flex;
  gap: 0.5rem;
}

.message-input textarea {
  flex: 1;
  padding: 0.75rem;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 8px;
  color: inherit;
  font-size: 1rem;
  resize: none;
}

/* Status */
.status-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot.status-idle { background: #888; }
.status-dot.status-owned { background: #4f4; }
.status-dot.status-external { background: #ff4; }

.status-disconnected {
  color: #f84;
  font-size: 0.875rem;
}

.abort-button {
  padding: 0.25rem 0.75rem;
  background: #a44;
  font-size: 0.875rem;
}
```

## E2E Testing with Playwright

### Dependencies

```bash
pnpm --filter client add -D @playwright/test
pnpm --filter client exec playwright install chromium
```

### Playwright Config

```typescript
// packages/client/playwright.config.ts

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,  // Run sequentially - we're hitting one server
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter server dev:mock',
      port: 3400,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm --filter client dev',
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

### Mock Server Mode

Add a script that starts the server with MockClaudeSDK:

```typescript
// packages/server/src/dev-mock.ts

import { serve } from '@hono/node-server';
import { createApp } from './app';
import { MockClaudeSDK } from './sdk/mock';
import { Supervisor } from './supervisor/Supervisor';

// Canned responses for e2e testing
const mockScenarios = [
  [
    { type: 'system', subtype: 'init', session_id: 'test-session-001', timestamp: new Date().toISOString() },
    { type: 'assistant', message: { role: 'assistant', content: 'Hello! I received your message.' }, session_id: 'test-session-001', timestamp: new Date().toISOString() },
    { type: 'result', session_id: 'test-session-001', timestamp: new Date().toISOString() },
  ],
];

const sdk = new MockClaudeSDK(mockScenarios);
const supervisor = new Supervisor(sdk);
const app = createApp({ supervisor });

serve({ fetch: app.fetch, port: 3400 }, () => {
  console.log('Mock server running at http://localhost:3400');
});
```

```json
// packages/server/package.json (add script)
{
  "scripts": {
    "dev:mock": "tsx src/dev-mock.ts"
  }
}
```

### E2E Test Files

```typescript
// packages/client/e2e/navigation.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('loads projects page', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.locator('h1')).toHaveText('Projects');
  });

  test('can navigate to project', async ({ page }) => {
    await page.goto('/projects');
    
    // Wait for projects to load
    await page.waitForSelector('.project-list a');
    
    // Click first project
    await page.locator('.project-list a').first().click();
    
    // Should be on sessions page
    await expect(page.locator('h2')).toHaveText('Sessions');
  });

  test('URL is stable on refresh', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-list a');
    await page.locator('.project-list a').first().click();
    
    const url = page.url();
    
    // Refresh
    await page.reload();
    
    // Should be same URL
    expect(page.url()).toBe(url);
    await expect(page.locator('h2')).toHaveText('Sessions');
  });
});
```

```typescript
// packages/client/e2e/session.spec.ts

import { test, expect } from '@playwright/test';

test.describe('Session Flow', () => {
  test('can start a new session', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-list a');
    await page.locator('.project-list a').first().click();
    
    // Type a message
    await page.fill('.new-session-form input', 'Hello Claude');
    await page.click('.new-session-form button');
    
    // Should navigate to chat page
    await expect(page).toHaveURL(/\/sessions\//);
    
    // Should see the chat interface
    await expect(page.locator('.chat-messages')).toBeVisible();
  });

  test('receives streamed response', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-list a');
    await page.locator('.project-list a').first().click();
    
    await page.fill('.new-session-form input', 'Test message');
    await page.click('.new-session-form button');
    
    // Wait for assistant message to appear
    await expect(page.locator('.message-assistant')).toBeVisible({ timeout: 10000 });
    
    // Should contain response text
    await expect(page.locator('.message-assistant .message-content')).toContainText('Hello');
  });

  test('shows status indicator', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-list a');
    await page.locator('.project-list a').first().click();
    
    await page.fill('.new-session-form input', 'Test');
    await page.click('.new-session-form button');
    
    // Should show running status initially, then idle
    await expect(page.locator('.status-indicator')).toBeVisible();
    
    // Eventually should show idle
    await expect(page.locator('.status-text')).toHaveText('Idle', { timeout: 10000 });
  });

  test('can send follow-up message', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-list a');
    await page.locator('.project-list a').first().click();
    
    // Start session
    await page.fill('.new-session-form input', 'First message');
    await page.click('.new-session-form button');
    
    // Wait for response
    await expect(page.locator('.message-assistant')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.status-text')).toHaveText('Idle', { timeout: 10000 });
    
    // Send follow-up
    await page.fill('.message-input textarea', 'Second message');
    await page.click('.message-input button');
    
    // Should see new user message
    await expect(page.locator('.message-user').nth(1)).toBeVisible({ timeout: 5000 });
  });
});
```

```typescript
// packages/client/e2e/reconnect.spec.ts

import { test, expect } from '@playwright/test';

test.describe('SSE Reconnection', () => {
  test('reconnects after connection drop', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-list a');
    await page.locator('.project-list a').first().click();
    
    await page.fill('.new-session-form input', 'Test');
    await page.click('.new-session-form button');
    
    // Wait for stream to connect
    await expect(page.locator('.message-assistant')).toBeVisible({ timeout: 10000 });
    
    // Simulate network interruption by going offline
    await page.context().setOffline(true);
    
    // Should show reconnecting
    await expect(page.locator('.status-disconnected')).toBeVisible({ timeout: 5000 });
    
    // Go back online
    await page.context().setOffline(false);
    
    // Should reconnect (disconnected indicator should disappear)
    await expect(page.locator('.status-disconnected')).not.toBeVisible({ timeout: 10000 });
  });
});
```

### Mock Data Setup

The mock server needs some project/session data to exist:

```typescript
// packages/server/src/testing/mockProjectData.ts

import fs from 'fs';
import path from 'path';
import os from 'os';

export function setupMockProjects() {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const mockProjectDir = path.join(claudeDir, 'mock-test-project');
  
  // Create directory if needed
  fs.mkdirSync(mockProjectDir, { recursive: true });
  
  // Create a mock session file
  const sessionFile = path.join(mockProjectDir, 'mock-session-001.jsonl');
  if (!fs.existsSync(sessionFile)) {
    const mockMessages = [
      { type: 'user', message: { role: 'user', content: 'Previous message' }, timestamp: new Date().toISOString(), uuid: '1' },
    ];
    fs.writeFileSync(sessionFile, mockMessages.map(m => JSON.stringify(m)).join('\n'));
  }
  
  return { projectDir: mockProjectDir, sessionFile };
}
```

Update dev-mock.ts to call this:

```typescript
// packages/server/src/dev-mock.ts (updated)

import { setupMockProjects } from './testing/mockProjectData';

// Ensure mock data exists
setupMockProjects();

// ... rest of file
```

### Scripts

```json
// packages/client/package.json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

```json
// Root package.json
{
  "scripts": {
    "test:e2e": "pnpm --filter client test:e2e"
  }
}
```

## Vite Proxy Config

```typescript
// packages/client/vite.config.ts

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3400',
        changeOrigin: true,
      },
    },
  },
});
```

## Types (shared or duplicated for now)

```typescript
// packages/client/src/types.ts

// Copy the essential types from server for now
// Later could be a shared package

interface Project {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
}

interface SessionSummary {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  status: SessionStatus;
}

type SessionStatus = 
  | { state: 'idle' }
  | { state: 'owned'; processId: string }
  | { state: 'external' };

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | unknown[];
  timestamp: string;
}
```

## Verification Checklist

- [ ] `pnpm dev` starts both server and client
- [ ] `pnpm test:e2e` passes all Playwright tests
- [ ] Navigate to http://localhost:5173
- [ ] See list of projects (from ~/.claude/projects)
- [ ] Click project → see sessions
- [ ] Start new session → redirects to chat view
- [ ] See messages streaming in real-time
- [ ] Send another message (queues or resumes)
- [ ] Abort button stops the process
- [ ] Refresh page → stays on same session
- [ ] SSE reconnects if connection drops

## CI Integration (Optional)

```yaml
# .github/workflows/e2e.yml (if you want it)
name: E2E Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm exec playwright install chromium
      - run: pnpm test:e2e
```

## Out of Scope

- Pretty UI / proper design
- Tool approval UI (use bypassPermissions for now)
- File upload
- Push notifications
- Error handling polish
- Mobile optimization
