/**
 * What the side panel and the toolbar badge show: the sessions that mention
 * the issue in a tab, and the sessions that need attention, across the
 * extension's active hosts. Each host answers independently; one host being
 * offline or signed out never hides another's sessions.
 */

import {
  issueLookupUrl,
  type IssueItem,
  type IssueSearchResult,
  type IssueUrlReference,
  type ProviderName,
  type SessionProviderPhase,
} from "@yep-anywhere/shared";
import type { InboxItem, InboxResponse } from "../api/client";
import { createIssuesApi } from "../api/issuesClient";
import type { SavedHost } from "../lib/hostStorage";
import { type InboxSection, splitInboxSections } from "../lib/inboxSections";
import {
  documentSavedHostCredentials,
  isSavedHostSignInRequiredError,
  type SavedHostCredentials,
} from "../lib/savedHostConnection";
import { getChrome } from "./chrome";
import { withHost } from "./hostLinks";

export type PanelSessionState = "approval" | "question" | "running" | "idle";

export interface PanelSession {
  host: SavedHost;
  sessionId: string;
  projectId: string;
  projectName?: string;
  title: string;
  provider?: ProviderName;
  model?: string;
  updatedAt?: string;
  lastAgentText?: string | null;
  state: PanelSessionState;
  /** What a running session's provider is doing, from the host's inbox. */
  providerPhase?: SessionProviderPhase;
  /** Mentions of the looked-up issue in this session. */
  mentions?: number;
}

export type HostStatus = "ok" | "issues-off" | "sign-in" | "error";

export interface HostAnswer {
  host: SavedHost;
  status: HostStatus;
  error?: string;
}

export interface IssueLookup {
  reference: IssueUrlReference;
  /** The first host's record of the item, for its title. */
  item: IssueItem | null;
  hosts: HostAnswer[];
  sessions: PanelSession[];
}

/** The Inbox's sections, merged across hosts; recent is capped. */
export interface AttentionView {
  hosts: HostAnswer[];
  needsAttention: PanelSession[];
  active: PanelSession[];
  background: PanelSession[];
  recent: PanelSession[];
}

const STATE_ORDER: Record<PanelSessionState, number> = {
  approval: 0,
  question: 0,
  running: 1,
  idle: 2,
};

function bySessionPriority(a: PanelSession, b: PanelSession): number {
  return (
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  );
}

function inboxState(item: Pick<InboxItem, "pendingInputType" | "activity">) {
  if (item.pendingInputType === "tool-approval") return "approval";
  if (item.pendingInputType === "user-question") return "question";
  return item.activity === "in-turn" ? "running" : "idle";
}

function answerFor(host: SavedHost, error: unknown): HostAnswer {
  if (isSavedHostSignInRequiredError(error)) return { host, status: "sign-in" };
  if ((error as { status?: number }).status === 403)
    return { host, status: "issues-off" };
  return {
    host,
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Each host's `/inbox`, requested once so the views one panel refresh loads
 * read the same answer.
 */
export type HostInboxes = ReadonlyMap<string, Promise<InboxResponse>>;

function fetchInbox(
  host: SavedHost,
  credentials: SavedHostCredentials,
): Promise<InboxResponse> {
  return withHost(
    host,
    (connection) => connection.fetch<InboxResponse>("/inbox"),
    credentials,
  );
}

export function fetchInboxes(
  hosts: SavedHost[],
  credentials: SavedHostCredentials = documentSavedHostCredentials,
): HostInboxes {
  return new Map(
    hosts.map((host) => {
      const inbox = fetchInbox(host, credentials);
      // Each reader handles a failure; this keeps one that no view ends up
      // reading from surfacing as an unhandled rejection.
      inbox.catch(() => {});
      return [host.id, inbox];
    }),
  );
}

function inboxSession(host: SavedHost, item: InboxItem): PanelSession {
  return {
    host,
    sessionId: item.sessionId,
    projectId: item.projectId,
    projectName: item.projectName,
    title: item.customTitle || item.sessionTitle || item.sessionId,
    updatedAt: item.updatedAt,
    state: inboxState(item),
    providerPhase: item.providerPhase,
  };
}

/** Sessions on every active host that mention the item `url` names. */
export async function lookupIssue(
  url: string,
  hosts: SavedHost[],
  options: {
    includeDismissed?: boolean;
    credentials?: SavedHostCredentials;
    /** Inboxes already requested for this refresh, reused for live state. */
    inboxes?: HostInboxes;
  } = {},
): Promise<IssueLookup | null> {
  const reference = issueLookupUrl(url);
  if (!reference) return null;
  const credentials = options.credentials ?? documentSavedHostCredentials;
  const answers = await Promise.all(
    hosts.map(async (host) => {
      try {
        return await withHost(
          host,
          async (connection) => {
            const issues = createIssuesApi((path, init) =>
              connection.fetch(path, init),
            );
            const found = await issues.lookup(url, {
              dismissed: options.includeDismissed,
            });
            const item = found?.items[0] ?? null;
            if (!item || item.sessionCount === 0)
              return {
                answer: { host, status: "ok" as const },
                item,
                sessions: [],
              };
            const [sessions, inbox] = await Promise.all([
              issues.sessions(item.id, {
                dismissed: options.includeDismissed,
              }),
              (
                options.inboxes?.get(host.id) ?? fetchInbox(host, credentials)
              ).catch(() => null),
            ]);
            // Live input and phase state come from the host's inbox rows.
            const live = new Map(
              [...(inbox?.needsAttention ?? []), ...(inbox?.active ?? [])].map(
                (entry) => [entry.sessionId, entry],
              ),
            );
            return {
              answer: { host, status: "ok" as const },
              item,
              sessions: sessions.sessions.map(
                (session): PanelSession => ({
                  host,
                  sessionId: session.sessionId,
                  projectId: session.projectId,
                  projectName: session.projectName,
                  title: session.title || session.sessionId,
                  provider: session.provider,
                  model: session.model,
                  updatedAt: session.updatedAt,
                  lastAgentText: session.lastAgentText,
                  state: inboxState({
                    pendingInputType: live.get(session.sessionId)
                      ?.pendingInputType,
                    activity: session.activity,
                  }),
                  providerPhase: live.get(session.sessionId)?.providerPhase,
                  mentions: session.evidenceCount,
                }),
              ),
            };
          },
          credentials,
        );
      } catch (error) {
        return { answer: answerFor(host, error), item: null, sessions: [] };
      }
    }),
  );
  return {
    reference,
    item:
      answers.find((answer) => answer.item?.title)?.item ??
      answers.find((answer) => answer.item)?.item ??
      null,
    hosts: answers.map((answer) => answer.answer),
    sessions: answers
      .flatMap((answer): PanelSession[] => answer.sessions)
      .sort(bySessionPriority),
  };
}

/**
 * How many sessions across hosts mention the item `url` names, for the
 * toolbar badge: one request per host, no session details.
 */
export async function countIssueSessions(
  url: string,
  hosts: SavedHost[],
  options: {
    includeDismissed?: boolean;
    credentials?: SavedHostCredentials;
  } = {},
): Promise<number | null> {
  if (!issueLookupUrl(url)) return null;
  const counts = await Promise.all(
    hosts.map((host) =>
      withHost(
        host,
        async (connection) => {
          const found = await createIssuesApi((path, init) =>
            connection.fetch(path, init),
          ).lookup(url, { dismissed: options.includeDismissed });
          return found?.items[0]?.sessionCount ?? 0;
        },
        options.credentials,
      ).catch(() => 0),
    ),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * The Inbox's needs-attention, active, background and recent sections on
 * every host, split exactly as the Inbox page splits them.
 */
export async function loadAttention(
  hosts: SavedHost[],
  inboxes: HostInboxes = fetchInboxes(hosts),
): Promise<AttentionView> {
  const answers = await Promise.all(
    hosts.map(async (host) => {
      try {
        const inbox = await inboxes.get(host.id);
        if (!inbox) throw new Error("No inbox was requested for this host");
        return {
          answer: { host, status: "ok" as const },
          sections: splitInboxSections(inbox),
        };
      } catch (error) {
        return { answer: answerFor(host, error), sections: null };
      }
    }),
  );
  const merged = (section: InboxSection) =>
    answers
      .flatMap(({ answer, sections }) =>
        sections
          ? sections[section].map((item) => inboxSession(answer.host, item))
          : [],
      )
      .sort(bySessionPriority);
  return {
    hosts: answers.map((answer) => answer.answer),
    needsAttention: merged("needsAttention"),
    active: merged("active"),
    background: merged("background"),
    recent: merged("recentActivity").slice(0, 8),
  };
}

/** A session page of the YA app, by its relay host's username. */
export interface SessionRoute {
  relayUsername: string;
  projectId: string;
  sessionId: string;
}

export interface SessionIssues {
  route: SessionRoute;
  /** The active host serving the session; null when none matches. */
  host: SavedHost | null;
  hosts: HostAnswer[];
  items: IssueItem[];
  statusRefreshing?: boolean;
}

const SESSION_PATH =
  /\/-\/relay\/([^/]+)\/projects\/([^/]+)\/sessions\/([^/]+)/;

/**
 * The session a YA page shows: this extension's own app tab, or the hosted
 * app on yepanywhere.com and its subdomains, under any base path.
 */
export function sessionPageRoute(
  url: string,
  extensionId = getChrome()?.runtime.id,
): SessionRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const own =
    parsed.protocol === "chrome-extension:" &&
    !!extensionId &&
    parsed.host === extensionId;
  const hosted =
    parsed.protocol === "https:" &&
    !/^artifact-[a-f0-9]{32}\.yepanywhere\.com$/.test(parsed.hostname) &&
    (parsed.hostname === "yepanywhere.com" ||
      parsed.hostname.endsWith(".yepanywhere.com"));
  const match = (own || hosted) && parsed.pathname.match(SESSION_PATH);
  if (!match) return null;
  try {
    return {
      relayUsername: decodeURIComponent(match[1]!),
      projectId: decodeURIComponent(match[2]!),
      sessionId: decodeURIComponent(match[3]!),
    };
  } catch {
    return null;
  }
}

/** The issues and PRs a session mentions, from the active host serving it. */
export async function lookupSessionIssues(
  route: SessionRoute,
  hosts: SavedHost[],
  credentials: SavedHostCredentials = documentSavedHostCredentials,
): Promise<SessionIssues> {
  const host =
    hosts.find(
      (candidate) =>
        candidate.relayUsername?.toLowerCase() ===
        route.relayUsername.toLowerCase(),
    ) ?? null;
  if (!host) return { route, host, hosts: [], items: [] };
  try {
    const result = await withHost(
      host,
      (connection) =>
        connection.fetch<IssueSearchResult>(
          `/issues?${new URLSearchParams({
            sessionId: route.sessionId,
            projectId: route.projectId,
            limit: "100",
            sort: "mentioned",
          })}`,
        ),
      credentials,
    );
    return {
      route,
      host,
      hosts: [{ host, status: "ok" }],
      items: result.items,
      statusRefreshing: result.statusRefreshing,
    };
  } catch (error) {
    return { route, host, hosts: [answerFor(host, error)], items: [] };
  }
}

/** The app path of a session on a relay host. */
export function sessionPath(session: PanelSession): string {
  return `/-/relay/${encodeURIComponent(session.host.relayUsername ?? "")}/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.sessionId)}`;
}

export function hostPath(host: SavedHost, rest: string): string {
  return `/-/relay/${encodeURIComponent(host.relayUsername ?? "")}/${rest.replace(/^\//, "")}`;
}
