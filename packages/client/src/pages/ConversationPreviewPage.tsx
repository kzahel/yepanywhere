import type { Content } from "@yep-anywhere/shared/experimental/simple-client.generated";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { type MessageKey, useI18n } from "../i18n";
import { loadSavedHosts } from "../lib/hostStorage";
import { previewFullClientPath } from "../lib/experimental/previewLinks";
import {
  PreviewController,
  type PreviewStatus,
} from "../lib/experimental/previewController";
import {
  previewGroups,
  type PreviewGrouping,
} from "../lib/experimental/previewGroups";
import styles from "./ConversationPreviewPage.module.css";

const statusKeys: Record<PreviewStatus, MessageKey> = {
  excluded: "preview.status.excluded",
  connecting: "preview.status.connecting",
  ready: "preview.status.ready",
  offline: "preview.status.offline",
  "sign-in-required": "preview.status.signIn",
  "update-required": "preview.status.update",
  "revision-mismatch": "preview.status.revision",
};
const includedKey = "yep-experimental-preview-sources";

export function PreviewContent({ content }: { content: Content }) {
  const { t } = useI18n();
  switch (content.kind) {
    case "text":
      return <div className={styles.prose}>{content.text}</div>;
    case "activity":
      return (
        <div className={styles.activity}>
          <p>{content.summary}</p>
          <small>
            {t(content.toolCount === 1 ? "preview.toolOne" : "preview.tools", {
              count: content.toolCount,
              failed: content.failedToolCount,
            })}
          </small>
        </div>
      );
    case "failure":
      return (
        <div className={styles.failure}>
          <strong>{content.toolName}</strong>
          <p>{content.message}</p>
        </div>
      );
    case "media":
      return (
        <div className={styles.activity}>
          {t("preview.media", {
            description: content.description || t("preview.attachment"),
          })}
        </div>
      );
    default:
      return <p className={styles.notice}>{t("preview.unknown")}</p>;
  }
}

function Preview({ controller }: { controller: PreviewController }) {
  const { t } = useI18n();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [, setSearch] = useSearchParams();
  const [grouping, setGrouping] = useState<PreviewGrouping>("machine");
  const [sidebarOpen, setSidebarOpen] = useState(!state.selection);
  const groups = useMemo(
    () => previewGroups(state.sources, grouping),
    [state.sources, grouping],
  );
  const source = state.sources.find(
    (item) => item.host.id === state.selection?.sourceId,
  );
  const session = source?.sessions.find(
    (item) => item.id === state.selection?.sessionId,
  );
  const view = state.view?.kind === "conversation" ? state.view : null;
  const busy = state.conversationStatus === "loading";
  const fullPath = source ? previewFullClientPath(source.host, session) : null;
  function include(id: string, value: boolean) {
    controller.include(id, value);
    try {
      localStorage.setItem(
        includedKey,
        JSON.stringify(
          controller
            .getSnapshot()
            .sources.filter((item) => item.status !== "excluded")
            .map((item) => item.host.id),
        ),
      );
    } catch {
      /* Storage may be disabled. */
    }
    if (!controller.getSnapshot().selection) setSearch({}, { replace: true });
  }
  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div>
          <h1>{t("preview.title")}</h1>
          <span className={styles.muted}>{t("preview.subtitle")}</span>
        </div>
        <Link className={styles.control} to="/login">
          {t("preview.fullApp")}
        </Link>
      </header>
      <button
        type="button"
        className={`${styles.control} ${styles.mobileToggle}`}
        aria-expanded={sidebarOpen}
        aria-controls="preview-sidebar"
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        {t(sidebarOpen ? "preview.hideSessions" : "preview.showSessions")}
      </button>
      <div className={styles.workspace}>
        <aside
          id="preview-sidebar"
          className={styles.sidebar}
          data-open={sidebarOpen}
          aria-label={t("preview.sessions")}
        >
          <section className={styles.sources}>
            <div className={styles.sectionHeading}>
              <h2>{t("preview.machines")}</h2>
              <Link to="/login">{t("preview.addMachine")}</Link>
            </div>
            {state.sources.length === 0 && (
              <p className={styles.muted}>{t("preview.noMachines")}</p>
            )}
            {state.sources.map((item) => (
              <div
                key={item.host.id}
                className={styles.source}
                data-testid="preview-source"
                data-source-name={item.host.displayName}
                data-source-status={item.status}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={item.status !== "excluded"}
                    onChange={(event) =>
                      include(item.host.id, event.target.checked)
                    }
                  />
                  <span>{item.host.displayName}</span>
                </label>
                <div className={styles.sourceDetail}>
                  <span>{t(statusKeys[item.status])}</span>
                  {item.status !== "excluded" &&
                    item.status !== "connecting" && (
                      <button
                        type="button"
                        className={styles.control}
                        onClick={() => controller.include(item.host.id, true)}
                      >
                        {t("preview.refresh")}
                      </button>
                    )}
                </div>
                {item.status === "sign-in-required" && (
                  <Link
                    to={
                      item.host.mode === "relay"
                        ? `/login/relay?u=${encodeURIComponent(item.host.relayUsername ?? "")}&r=${encodeURIComponent(item.host.relayUrl ?? "")}`
                        : "/login/direct"
                    }
                  >
                    {t("preview.signIn")}
                  </Link>
                )}
                {["offline", "update-required", "revision-mismatch"].includes(
                  item.status,
                ) && (
                  <Link
                    className={styles.control}
                    to={
                      previewFullClientPath(item.host) ??
                      (item.host.mode === "relay"
                        ? "/login/relay"
                        : "/login/direct")
                    }
                  >
                    {t("preview.fullApp")}
                  </Link>
                )}
                {grouping === "issue" && item.status === "ready" && (
                  <p className={styles.muted}>
                    {t(`preview.issues.${item.issueCoverage}`)}
                  </p>
                )}
                {item.hasMore && item.status === "ready" && (
                  <small className={styles.muted}>
                    {t("preview.catalogLimit")}
                  </small>
                )}
              </div>
            ))}
          </section>
          <label className={styles.groupControl}>
            {t("preview.groupBy")}
            <select
              value={grouping}
              onChange={(event) =>
                setGrouping(event.target.value as PreviewGrouping)
              }
            >
              <option value="machine">{t("preview.byMachine")}</option>
              <option value="project">{t("preview.byProject")}</option>
              <option value="issue">{t("preview.byIssue")}</option>
            </select>
          </label>
          <nav aria-label={t("preview.sessions")} className={styles.groups}>
            {groups.length === 0 && (
              <p className={styles.muted}>{t("preview.noSessions")}</p>
            )}
            {groups.map((group) => (
              <section key={group.id}>
                <h3>
                  {group.label ?? t("preview.noIssueLinks")}
                  <small>{group.sourceName}</small>
                </h3>
                {group.rows.map(({ source: rowSource, session: row }) => (
                  <button
                    type="button"
                    key={JSON.stringify([rowSource.host.id, row.id])}
                    className={styles.session}
                    aria-current={
                      state.selection?.sourceId === rowSource.host.id &&
                      state.selection.sessionId === row.id
                        ? "true"
                        : undefined
                    }
                    onClick={() => {
                      controller.select(rowSource.host.id, row.id);
                      setSearch(
                        { source: rowSource.host.id, session: row.id },
                        { replace: true },
                      );
                      setSidebarOpen(false);
                    }}
                  >
                    <span>{row.title}</span>
                    <small>
                      {grouping === "machine"
                        ? row.projectName
                        : rowSource.host.displayName}
                    </small>
                  </button>
                ))}
              </section>
            ))}
          </nav>
        </aside>
        <main className={styles.main}>
          {!state.selection ? (
            <div className={styles.empty}>
              <h2>{t("preview.welcome")}</h2>
              <p>{t("preview.chooseSession")}</p>
              <p className={styles.muted}>{t("preview.readOnly")}</p>
            </div>
          ) : (
            <>
              <header className={styles.conversationHeader}>
                <small className={styles.muted}>
                  {source?.host.displayName} · {session?.projectName}
                </small>
                <h2>{session?.title ?? state.selection.sessionId}</h2>
                <div className={styles.actions}>
                  <span className={styles.badge}>
                    {t("preview.readOnlyBadge")}
                  </span>
                  {view && (
                    <span>{t(`preview.activity.${view.activity}`)}</span>
                  )}
                  {fullPath ? (
                    <Link className={styles.control} to={fullPath}>
                      {t("preview.openFull")}
                    </Link>
                  ) : (
                    <Link className={styles.control} to="/login/direct">
                      {t("preview.fullApp")}
                    </Link>
                  )}
                </div>
              </header>
              <div
                className={styles.transcript}
                data-testid="preview-conversation"
              >
                {busy && (
                  <p role="status" className={styles.notice}>
                    {t("preview.loading")}
                  </p>
                )}
                {state.conversationStatus === "offline" && (
                  <div role="status" className={styles.notice}>
                    <p>{t("preview.disconnected")}</p>
                    {source && (
                      <button
                        className={styles.control}
                        type="button"
                        onClick={() => controller.include(source.host.id, true)}
                      >
                        {t("preview.reconnect")}
                      </button>
                    )}
                  </div>
                )}
                {state.conversationStatus === "invalid" && (
                  <p role="alert" className={styles.notice}>
                    {t("preview.invalid")}
                  </p>
                )}
                {state.view?.kind === "error" && (
                  <p role="status" className={styles.notice}>
                    {t(`preview.error.${state.view.code}`)}
                  </p>
                )}
                {state.view &&
                  state.view.kind !== "conversation" &&
                  state.view.kind !== "error" && (
                    <p className={styles.notice}>{t("preview.unknown")}</p>
                  )}
                {view && (
                  <>
                    <div className={styles.history}>
                      <span>
                        {t(
                          view.coverage.returnedMessages === 1
                            ? "preview.messageCountOne"
                            : "preview.messageCount",
                          {
                            count: view.coverage.returnedMessages,
                          },
                        )}
                      </span>
                      <button
                        type="button"
                        className={styles.control}
                        disabled={
                          busy ||
                          state.maxMessages >= 100 ||
                          !view.coverage.earlierInScope ||
                          source?.status !== "ready"
                        }
                        onClick={() => controller.more()}
                      >
                        {t("preview.more")}
                      </button>
                      <button
                        type="button"
                        className={styles.control}
                        disabled={busy || source?.status !== "ready"}
                        onClick={() => controller.latest()}
                      >
                        {t("preview.latest")}
                      </button>
                    </div>
                    {state.anchorMessageId && (
                      <p className={styles.muted}>{t("preview.anchored")}</p>
                    )}
                    {(!view.coverage.completeForRequest ||
                      view.coverage.earlierOutsideScope !== "no" ||
                      (state.maxMessages >= 100 &&
                        view.coverage.earlierInScope)) && (
                      <p className={styles.notice}>{t("preview.coverage")}</p>
                    )}
                    {view.messages.length === 0 && (
                      <p className={styles.muted}>
                        {t("preview.emptyConversation")}
                      </p>
                    )}
                    {view.messages.map((message) => (
                      <article
                        key={message.id}
                        className={styles.message}
                        data-role={message.role}
                      >
                        <header>
                          <strong>
                            {t(
                              message.role === "user"
                                ? "preview.you"
                                : "preview.agent",
                            )}
                          </strong>
                          {message.state !== "complete" && (
                            <small>
                              {t(`preview.message.${message.state}`)}
                            </small>
                          )}
                        </header>
                        {message.content.map((content, index) => (
                          <PreviewContent
                            key={`${message.id}:${index}`}
                            content={content}
                          />
                        ))}
                        {message.truncated && (
                          <small className={styles.muted}>
                            {t("preview.truncated")}
                          </small>
                        )}
                      </article>
                    ))}
                    {view.pendingRequests.map((request, index) => (
                      <section
                        key={
                          request.kind === "question"
                            ? request.id
                            : `unknown:${index}`
                        }
                        className={styles.notice}
                      >
                        <strong>{t("preview.needsAttention")}</strong>
                        <p>
                          {request.kind === "question"
                            ? request.prompt
                            : t("preview.unknown")}
                        </p>
                        <small>{t("preview.answerInFull")}</small>
                      </section>
                    ))}
                  </>
                )}
                {state.view?.kind === "error" && source?.status === "ready" && (
                  <button
                    type="button"
                    className={styles.control}
                    onClick={() => controller.latest()}
                  >
                    {t("preview.latest")}
                  </button>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export function ConversationPreviewPage() {
  const [controller, setController] = useState<PreviewController | null>(null);
  const [search] = useSearchParams();
  // An effect owns each controller lifetime, including StrictMode remounts.
  const [initialSelection] = useState(() =>
    search.get("source") && search.get("session")
      ? {
          sourceId: search.get("source") as string,
          sessionId: search.get("session") as string,
        }
      : null,
  );
  useEffect(() => {
    const next = new PreviewController(
      loadSavedHosts().hosts,
      undefined,
      initialSelection,
    );
    setController(next);
    let included: string[] = [];
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(includedKey) ?? "[]",
      );
      if (Array.isArray(value))
        included = value.filter((id): id is string => typeof id === "string");
    } catch {
      /* Start with no included sources. */
    }
    if (initialSelection) included.push(initialSelection.sourceId);
    for (const id of new Set(included)) next.include(id, true);
    return () => next.dispose();
  }, [initialSelection]);
  return controller ? <Preview controller={controller} /> : null;
}
