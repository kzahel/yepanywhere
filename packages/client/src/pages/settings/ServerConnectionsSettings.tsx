import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type PeerConnectionDirection,
} from "@yep-anywhere/shared";
import { useVersion } from "../../hooks/useVersion";
import type {
  PeerConnectionEntry,
  PeerConnectionsResponse,
  PeerConnectionSetupRequest,
  PeerServerIdentity,
} from "@yep-anywhere/shared";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import {
  peerConnectionsApi,
  type PeerConnectionActivity,
} from "../../api/peerConnections";
import { useI18n } from "../../i18n";
import { SettingsSection } from "./SettingsSection";
import { Modal } from "../../components/ui/Modal";
import styles from "./ServerConnectionsSettings.module.css";

// Retain the existing wire discriminator for account-managed credentials.
const IDENTITY_SERVICE_CREDENTIAL_ORIGIN = "fleet";

// These owner dialogs keep keyboard navigation within the current action.
function ConnectionDialog({
  title,
  onClose,
  fallbackFocusRef,
  returnFocusRef,
  children,
}: {
  title: string;
  onClose: () => void;
  fallbackFocusRef: RefObject<HTMLButtonElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dialog = contentRef.current?.closest('[role="dialog"]');
    const previous = returnFocusRef.current;
    if (!dialog) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0],
        last = controls.at(-1);
      if (!first || !last) return;
      if (
        !dialog.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      document.removeEventListener("keydown", trap, true);
      // Removal may replace the initiating row and re-enable controls in this
      // commit. Restore after those DOM updates, unless another dialog opened.
      queueMicrotask(() => {
        if (document.querySelector('[role="dialog"][aria-modal="true"]'))
          return;
        const target = previous?.isConnected
          ? previous
          : fallbackFocusRef.current;
        target?.focus({ preventScroll: true });
      });
    };
  }, [fallbackFocusRef, returnFocusRef]);
  return (
    <Modal title={title} onClose={onClose} contentRef={contentRef}>
      {children}
    </Modal>
  );
}

function Host({
  identity,
  label,
  compact = false,
}: {
  identity: PeerServerIdentity;
  label?: string;
  compact?: boolean;
}) {
  const os =
    { darwin: "macOS", win32: "Windows", linux: "Linux" }[identity.os] ??
    identity.os;
  return (
    <div className={styles.host}>
      <span className={styles.icon} aria-hidden="true">
        {identity.icon ?? "🖥️"}
      </span>
      <div>
        <strong>{label ?? identity.hostname}</strong>
        <div className={styles.muted}>
          {label && `${identity.hostname} · `}
          {os}
          {!compact && ` · ${identity.architecture}`}
        </div>
      </div>
    </div>
  );
}
export function ServerConnectionsSettings() {
  const { t } = useI18n();
  const { version } = useVersion();
  const supportsRefresh = serverHasCapability(
    version,
    SERVER_CAPABILITIES.peerAuthenticationRefresh,
  );
  const [automatic, setAutomatic] = useState(true);
  const basePath = useRemoteBasePath();
  const [data, setData] = useState<PeerConnectionsResponse>();
  const [cursor, setCursor] = useState("0"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [reverseOnly, setReverseOnly] = useState(false);
  const [form, setForm] = useState(false),
    [kind, setKind] = useState<"relay" | "direct">("relay"),
    [address, setAddress] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [label, setLabel] = useState(""),
    [both, setBoth] = useState(false),
    [returnAddress, setReturnAddress] = useState(""),
    [renew, setRenew] = useState<PeerConnectionEntry>();
  const [details, setDetails] = useState<string>(),
    [activity, setActivity] = useState<PeerConnectionActivity>(),
    [activityError, setActivityError] = useState(false),
    [newLabel, setNewLabel] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const [removing, setRemoving] = useState<{
    peer: PeerConnectionEntry;
    direction: "incoming" | "outgoing";
    credential: PeerConnectionDirection;
  }>();
  const [removalError, setRemovalError] = useState("");
  const detailRequest = useRef<string | undefined>(undefined);
  const loadRequest = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadRequest.current;
    const result = await peerConnectionsApi.list(cursor);
    if (generation === loadRequest.current) setData(result);
  }, [cursor]);
  useEffect(() => {
    let live = true;
    const generation = ++loadRequest.current;
    peerConnectionsApi
      .list(cursor)
      .then((value) => {
        if (live && generation === loadRequest.current) setData(value);
      })
      .catch(() => {
        if (live) setError(t("connectionsLoadError"));
      });
    return () => {
      live = false;
      detailRequest.current = undefined;
      loadRequest.current++;
    };
  }, [cursor, t]);
  const act = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      if (success) setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("connectionsActionError"));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (form) formRef.current?.scrollIntoView({ block: "start" });
  }, [form]);
  const openForm = (peer?: PeerConnectionEntry, reverse = false) => {
    if (!supportsRefresh) {
      setError(t("connectionsRefreshUpdate"));
      return;
    }
    setDetails(undefined);
    detailRequest.current = undefined;
    const directions = peer ? (reverse ? peer.incoming : peer.outgoing) : [];
    setAutomatic(
      !directions.length ||
        directions.some((p) => p.authentication?.mode === "automatic"),
    );
    setReverseOnly(reverse);
    setRenew(peer);
    setPassword("");
    setBoth(reverse);
    setLabel(peer?.label ?? "");
    setReturnAddress("");
    const route = peer?.setupRoute;
    setKind(route?.kind ?? "relay");
    setAddress(
      route?.url ?? data?.relay?.url ?? "wss://relay.yepanywhere.com/ws",
    );
    setUsername(
      peer?.setupUsername ?? (route?.kind === "relay" ? route.username : ""),
    );
    setForm(true);
    setError("");
    setNotice("");
  };
  const connect = async () => {
    const route =
      kind === "relay"
        ? { kind, url: address, username }
        : { kind, url: address };
    const input: PeerConnectionSetupRequest = {
      route,
      username,
      password,
      ...(label.trim() ? { label: label.trim() } : {}),
      bidirectional: both,
      automaticSignIn: automatic,
      ...(reverseOnly ? { direction: "incoming" as const } : {}),
      ...(returnAddress.trim()
        ? { returnRoute: { kind: "direct", url: returnAddress.trim() } }
        : {}),
      ...(renew ? { expectedServerId: renew.serverId, replace: true } : {}),
    };
    await act(async () => {
      const result = await peerConnectionsApi.connect(input);
      setPassword("");
      setForm(false);
      setNotice(
        result.outcome === "connected"
          ? t("connectionsConnected")
          : result.outcome === "partial"
            ? t("connectionsPartial")
            : t("connectionsUncertain"),
      );
      if (result.ownerSessionCleanup === "unconfirmed")
        setNotice(
          (previous) => `${previous} ${t("connectionsCleanupUnconfirmed")}`,
        );
      if (result.issue) setError(result.issue);
    });
  };
  const showDetails = async (peer: PeerConnectionEntry) => {
    if (details === peer.serverId) {
      detailRequest.current = undefined;
      setDetails(undefined);
      return;
    }
    dialogReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setError("");
    setNotice("");
    detailRequest.current = peer.serverId;
    setDetails(peer.serverId);
    setNewLabel(peer.label ?? peer.identity?.hostname ?? "");
    setActivity(undefined);
    setActivityError(false);
    try {
      const result = await peerConnectionsApi.activity(peer.serverId);
      if (detailRequest.current === peer.serverId) setActivity(result);
    } catch {
      if (detailRequest.current === peer.serverId) setActivityError(true);
    }
  };
  const authenticationText = (p: PeerConnectionDirection) => {
    const auth = p.authentication;
    if (!auth) return null;
    if (auth.status === "sign-in-required") return t("connectionsSignInAgain");
    if (auth.status === "update-required")
      return t("connectionsRefreshUpdatePeer");
    if (auth.status === "unavailable") return t("connectionsRefreshDelayed");
    return auth.mode === "automatic" ? t("connectionsAutomatic") : null;
  };
  const nameOf = (peer: PeerConnectionEntry) =>
    peer.label ?? peer.identity?.hostname ?? t("connectionsUnknownHost");
  const requestRemoval = (
    peer: PeerConnectionEntry,
    direction: "incoming" | "outgoing",
    credential: PeerConnectionDirection,
  ) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest('[role="dialog"]'))
      dialogReturnFocusRef.current = active;
    setDetails(undefined);
    detailRequest.current = undefined;
    setRemovalError("");
    setRemoving({ peer, direction, credential });
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setRemovalError("");
    setError("");
    setNotice("");
    let confirmed = false;
    try {
      const { peer, direction, credential } = removing;
      await peerConnectionsApi.remove(
        peer.serverId,
        direction,
        credential.credentialId,
        credential.generation,
      );
      confirmed = true;
      const result =
        direction === "incoming"
          ? t("connectionsRevoked")
          : t("connectionsStopped");
      setNotice(
        peer[direction].some(
          (p) => p.origin === IDENTITY_SERVICE_CREDENTIAL_ORIGIN,
        )
          ? t("connectionsManualRemoved")
          : result,
      );
      await load();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("connectionsActionError");
      if (confirmed) setError(message);
      else setRemovalError(message);
    } finally {
      setBusy(false);
      if (confirmed) setRemoving(undefined);
    }
  };
  const selectedPeer = data?.peers.find((peer) => peer.serverId === details);
  if (!data)
    return <p role={error ? "alert" : "status"}>{error || t("loading")}</p>;
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h2>{t("settingsServerConnectionsTitle")}</h2>
          <p className={styles.localIdentity}>
            <span aria-hidden="true">{data.identity.icon ?? "🖥️"}</span>
            <span>{data.identity.hostname}</span>
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          ref={addButtonRef}
          disabled={
            busy || !supportsRefresh || data.environmentOverride === false
          }
          onClick={() => openForm()}
        >
          {t("connectionsAdd")}
        </button>
      </header>
      {!data.enabled && (
        <div className={styles.feedback}>
          <span>{t("connectionsDisabled")}</span>
        </div>
      )}
      {!supportsRefresh && (
        <p className={styles.feedback}>{t("connectionsRefreshUpdate")}</p>
      )}
      {error && !selectedPeer && (
        <p role="alert" className={styles.feedback}>
          {error}
        </p>
      )}
      {notice && !selectedPeer && (
        <p role="status" className={styles.feedback}>
          {notice}
        </p>
      )}
      {form && (
        <form
          ref={formRef}
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <h3>{renew ? t("connectionsRenewTitle") : t("connectionsAdd")}</h3>
          <p className={styles.muted}>{t("connectionsTrustHint")}</p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={automatic}
              onChange={(e) => setAutomatic(e.target.checked)}
              disabled={busy}
            />
            {t("connectionsAutomatic")}
          </label>
          <p className={styles.muted}>
            {automatic
              ? t("connectionsAutomaticHint")
              : t("connectionsFixedHint")}
          </p>
          {renew && <p className={styles.muted}>{t("connectionsRenewHint")}</p>}
          <label>
            {t("connectionsRoute")}
            <select
              value={kind}
              disabled={busy}
              onChange={(e) => {
                setKind(e.target.value as "direct" | "relay");
                setAddress("");
              }}
            >
              <option value="relay">{t("connectionsRelay")}</option>
              <option value="direct">{t("connectionsDirect")}</option>
            </select>
          </label>
          <label>
            {kind === "relay"
              ? t("connectionsRelayUrl")
              : t("connectionsServerAddress")}
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={
                kind === "relay"
                  ? "wss://relay.yepanywhere.com/ws"
                  : "http://192.168.1.20:3400"
              }
              maxLength={2048}
              required
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <label>
            {t("connectionsUsername")}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              maxLength={128}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label>
            {t("connectionsPassword")}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              maxLength={4096}
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <p className={styles.muted}>{t("connectionsSrpHint")}</p>
          <label>
            {t("connectionsLabel")}
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={128}
              disabled={busy}
            />
          </label>
          {reverseOnly ? (
            <p>{t("connectionsReverseOnly")}</p>
          ) : (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={both}
                onChange={(e) => setBoth(e.target.checked)}
                disabled={busy}
              />
              <span>{t("connectionsBoth")}</span>
            </label>
          )}
          {both && kind === "direct" && !data.relay?.enabled && (
            <label>
              {t("connectionsReturnAddress")}
              <input
                value={returnAddress}
                onChange={(e) => setReturnAddress(e.target.value)}
                placeholder="ws://192.168.1.10:3400/peer/ws"
                required
                disabled={busy}
              />
              <span className={styles.muted}>{t("connectionsReturnHint")}</span>
            </label>
          )}
          <p className={styles.muted}>{t("connectionsOwnerSessionHint")}</p>
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy
                ? t("connectionsConnecting")
                : reverseOnly
                  ? t("connectionsReverse")
                  : renew
                    ? t("connectionsRenew")
                    : t("connectionsConnect")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setForm(false);
                setPassword("");
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}

      {(["outgoing", "incoming"] as const).map((direction) => {
        const peers = data.peers.filter((peer) => peer[direction].length > 0);
        const heading =
          direction === "outgoing"
            ? t("connectionsAccessibleDevices")
            : t("connectionsControllingDevices");
        return (
          <section
            key={direction}
            aria-label={heading}
            data-direction={direction}
          >
            <SettingsSection title={heading} className={styles.listSection}>
              {peers.length ? (
                <ul className={styles.deviceList}>
                  {peers.map((peer) => {
                    const credential =
                      peer[direction].find((p) => p.selected) ??
                      peer[direction].find((p) => p.active) ??
                      peer[direction][0]!;
                    const manual = peer[direction].find(
                      (p) => p.origin === "manual",
                    );
                    const managed = peer[direction].some(
                      (p) => p.origin === IDENTITY_SERVICE_CREDENTIAL_ORIGIN,
                    );
                    const needsSignIn =
                      credential.authentication?.status ===
                        "sign-in-required" ||
                      (!credential.authentication &&
                        credential.expiresAt <= Date.now());
                    const unselected =
                      direction === "outgoing" &&
                      peer.outgoing.every((p) => p.selected === false);
                    const problem = unselected
                      ? t("connectionsNotSelected")
                      : credential.authentication?.status &&
                          credential.authentication.status !== "ready"
                        ? authenticationText(credential)
                        : null;
                    return (
                      <li key={peer.serverId} className={styles.deviceRow}>
                        <div className={styles.deviceContent}>
                          <button
                            type="button"
                            className={styles.deviceName}
                            disabled={busy}
                            aria-label={t("connectionsViewDevice", {
                              name: nameOf(peer),
                            })}
                            onClick={() => void showDetails(peer)}
                          >
                            {peer.identity ? (
                              <Host
                                identity={peer.identity}
                                label={peer.label}
                                compact
                              />
                            ) : (
                              <strong>{nameOf(peer)}</strong>
                            )}
                          </button>
                          {needsSignIn && !unselected ? (
                            <button
                              type="button"
                              className={`btn ${styles.signIn}`}
                              disabled={
                                busy ||
                                !supportsRefresh ||
                                data.environmentOverride === false
                              }
                              onClick={() =>
                                openForm(peer, direction === "incoming")
                              }
                            >
                              {t("connectionsSignInAgain")}
                            </button>
                          ) : problem ? (
                            <p className={styles.problem}>{problem}</p>
                          ) : null}
                        </div>
                        {manual && !managed ? (
                          <button
                            type="button"
                            className={styles.remove}
                            disabled={busy}
                            aria-label={
                              direction === "incoming"
                                ? t("connectionsRemoveIncomingLabel", {
                                    name: nameOf(peer),
                                  })
                                : t("connectionsRemoveOutgoingLabel", {
                                    name: nameOf(peer),
                                  })
                            }
                            onClick={() =>
                              requestRemoval(peer, direction, manual)
                            }
                          >
                            ×
                          </button>
                        ) : (
                          <span className={styles.managed}>
                            {t("connectionsManaged")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className={styles.empty}>
                  {data.total > data.peers.length
                    ? t("connectionsEmptyPage")
                    : direction === "outgoing"
                      ? t("connectionsNoAccessibleDevices")
                      : t("connectionsNoControllingDevices")}
                </p>
              )}
            </SettingsSection>
          </section>
        );
      })}
      <div className={styles.actions}>
        {cursor !== "0" && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setCursor("0")}
          >
            {t("connectionsFirstPage")}
          </button>
        )}
        {data.nextCursor && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setCursor(data.nextCursor!)}
          >
            {t("connectionsMore")}
          </button>
        )}
      </div>
      <details className={styles.settings}>
        <summary>{t("connectionsSettings")}</summary>
        <p className={styles.muted}>
          {t("settingsServerConnectionsDescription")}
        </p>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void load().catch(() => setError(t("connectionsLoadError")))
          }
        >
          {t("connectionsRefresh")}
        </button>
      </details>
      {selectedPeer && (
        <ConnectionDialog
          fallbackFocusRef={addButtonRef}
          returnFocusRef={dialogReturnFocusRef}
          title={nameOf(selectedPeer)}
          onClose={() => {
            setDetails(undefined);
            detailRequest.current = undefined;
          }}
        >
          <div className={styles.detail}>
            {error && (
              <p role="alert" className={styles.feedback}>
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className={styles.feedback}>
                {notice}
              </p>
            )}
            <div className={styles.identifier}>
              <span>{t("connectionsServerId")}</span>
              <code>{selectedPeer.serverId}</code>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(() =>
                  peerConnectionsApi.label(selectedPeer.serverId, newLabel),
                );
              }}
            >
              <label>
                {t("connectionsLabel")}
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  required
                  maxLength={128}
                  disabled={busy}
                />
              </label>
              <button type="submit" className="btn" disabled={busy}>
                {t("connectionsSave")}
              </button>
            </form>
            {(["outgoing", "incoming"] as const).map((direction) =>
              selectedPeer[direction].map((credential) => (
                <div
                  className={styles.credential}
                  key={credential.credentialId}
                >
                  <strong>
                    {direction === "outgoing"
                      ? t("connectionsOutgoing")
                      : t("connectionsIncoming")}
                  </strong>
                  <p className={styles.muted}>
                    {credential.origin === IDENTITY_SERVICE_CREDENTIAL_ORIGIN
                      ? t("connectionsAccountCredential")
                      : credential.allProjects
                        ? t("connectionsTrustedControl")
                        : t("connectionsScoped")}{" "}
                    ·{" "}
                    {credential.authentication?.mode === "automatic"
                      ? t("connectionsAutomatic")
                      : t("connectionsExpires", {
                          date: new Date(credential.expiresAt).toLocaleString(),
                        })}
                  </p>
                  {credential.authentication && (
                    <>
                      {credential.authentication.status !== "ready" && (
                        <p>{authenticationText(credential)}</p>
                      )}
                      {credential.authentication.lastRefreshedAt && (
                        <p className={styles.muted}>
                          {t("connectionsLastSignIn", {
                            date: new Date(
                              credential.authentication.lastRefreshedAt,
                            ).toLocaleString(),
                          })}
                        </p>
                      )}
                      {credential.authentication.mode === "automatic" && (
                        <p className={styles.muted}>
                          {t("connectionsIdleDeadline", {
                            date: new Date(
                              credential.expiresAt,
                            ).toLocaleString(),
                          })}
                        </p>
                      )}
                      {credential.authentication.nextAttemptAt && (
                        <p className={styles.muted}>
                          {t("connectionsNextSignIn", {
                            date: new Date(
                              credential.authentication.nextAttemptAt,
                            ).toLocaleString(),
                          })}
                        </p>
                      )}
                    </>
                  )}
                  {credential.route && (
                    <p className={styles.muted}>
                      {credential.route.kind === "relay"
                        ? `${credential.route.username} · `
                        : ""}
                      {credential.route.url}
                    </p>
                  )}
                  {credential.origin === "manual" && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        requestRemoval(selectedPeer, direction, credential)
                      }
                    >
                      {direction === "incoming"
                        ? t("connectionsRevoke")
                        : t("connectionsStop")}
                    </button>
                  )}
                </div>
              )),
            )}
            <button
              type="button"
              className="btn"
              disabled={busy || !selectedPeer.outgoing.some((p) => p.active)}
              onClick={() =>
                void act(
                  () => peerConnectionsApi.test(selectedPeer.serverId),
                  t("connectionsTestPassed"),
                )
              }
            >
              {t("connectionsTest")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                busy || !supportsRefresh || data.environmentOverride === false
              }
              onClick={() => openForm(selectedPeer)}
            >
              {t("connectionsRenew")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                busy || !supportsRefresh || data.environmentOverride === false
              }
              onClick={() => openForm(selectedPeer, true)}
            >
              {t("connectionsReverse")}
            </button>
            <h4>{t("connectionsSessions")}</h4>
            {activityError ? (
              <p role="alert">{t("connectionsActivityError")}</p>
            ) : !activity ? (
              <p>{t("loading")}</p>
            ) : (
              <>
                {!activity.incoming.length && !activity.outgoing.length && (
                  <p className={styles.muted}>{t("connectionsNoSessions")}</p>
                )}
                {(["incoming", "outgoing"] as const).map((direction) =>
                  activity[direction].map((item) => (
                    <p className={styles.muted} key={item.id}>
                      {direction === "incoming"
                        ? t("connectionsIncoming")
                        : t("connectionsOutgoing")}{" "}
                      ·{" "}
                      {direction === "incoming" &&
                      item.projectId &&
                      item.sessionId ? (
                        <Link
                          to={`${basePath}/projects/${encodeURIComponent(item.projectId)}/sessions/${encodeURIComponent(item.sessionId)}`}
                        >
                          {item.sessionId}
                        </Link>
                      ) : (
                        (item.sessionId ?? t("connectionsPendingSession"))
                      )}{" "}
                      · {item.state}
                    </p>
                  )),
                )}
              </>
            )}
            <h4>{t("connectionsAudit")}</h4>
            {data.audit
              .filter((event) => event.serverId === selectedPeer.serverId)
              .map((event) => (
                <p className={styles.muted} key={event.id}>
                  {new Date(event.at).toLocaleString()} ·{" "}
                  {(
                    {
                      "pair-started": t("connectionsAuditStarted"),
                      "incoming-issued": t("connectionsAuditIncoming"),
                      "outgoing-imported": t("connectionsAuditOutgoing"),
                      "incoming-revoked": t("connectionsAuditRevoked"),
                      "outgoing-removed": t("connectionsAuditRemoved"),
                      verified: t("connectionsAuditVerified"),
                      "pair-completed": t("connectionsAuditCompleted"),
                      "pair-partial": t("connectionsPartialShort"),
                      "pair-uncertain": t("connectionsUncertainShort"),
                      "pair-failed": t("connectionsAuditFailed"),
                      "label-changed": t("connectionsAuditLabel"),
                      enabled: t("connectionsAuditEnabled"),
                      disabled: t("connectionsAuditDisabled"),
                    } as Record<string, string>
                  )[event.action] ?? t("connectionsAuditUpdated")}
                </p>
              ))}
          </div>
        </ConnectionDialog>
      )}
      {removing && (
        <ConnectionDialog
          fallbackFocusRef={addButtonRef}
          returnFocusRef={dialogReturnFocusRef}
          title={
            removing.direction === "incoming"
              ? t("connectionsRemoveIncomingTitle")
              : t("connectionsRemoveOutgoingTitle")
          }
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <div className={styles.confirmation}>
            <p>
              {removing.peer[removing.direction].some(
                (p) => p.origin === IDENTITY_SERVICE_CREDENTIAL_ORIGIN,
              )
                ? t("connectionsRemoveManualConfirm", {
                    name: nameOf(removing.peer),
                  })
                : removing.direction === "incoming"
                  ? t("connectionsRemoveIncomingConfirm", {
                      name: nameOf(removing.peer),
                      server: data.identity.hostname,
                    })
                  : t("connectionsRemoveOutgoingConfirm", {
                      name: nameOf(removing.peer),
                      server: data.identity.hostname,
                    })}
            </p>
            {removing.direction === "outgoing" &&
              removing.peer.outgoing.some(
                (p) => p.origin === IDENTITY_SERVICE_CREDENTIAL_ORIGIN,
              ) && (
                <p className={styles.muted}>
                  {t("connectionsRemoteGrantRemains")}
                </p>
              )}
            {removing.direction === "incoming" &&
              removing.peer.outgoing.length > 0 && (
                <p className={styles.muted}>
                  {t("connectionsKeepOutgoing", {
                    name: nameOf(removing.peer),
                  })}
                </p>
              )}
            {removing.direction === "outgoing" &&
              removing.peer.incoming.length > 0 && (
                <p className={styles.muted}>
                  {t("connectionsKeepIncoming", {
                    name: nameOf(removing.peer),
                  })}
                </p>
              )}
            {removing.peer[removing.direction].some(
              (p) => p.origin === IDENTITY_SERVICE_CREDENTIAL_ORIGIN,
            ) && (
              <p className={styles.muted}>
                {t("connectionsKeepAccountAccess")}
              </p>
            )}
            {removalError && (
              <p role="alert" className={styles.feedback}>
                {removalError}
              </p>
            )}
            <div className={styles.confirmActions}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setRemoving(undefined)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className={`btn ${styles.destructive}`}
                disabled={busy}
                onClick={() => void remove()}
              >
                {removing.direction === "incoming"
                  ? t("connectionsRemoveIncomingAction")
                  : t("connectionsRemoveOutgoingAction")}
              </button>
            </div>
          </div>
        </ConnectionDialog>
      )}
    </div>
  );
}
