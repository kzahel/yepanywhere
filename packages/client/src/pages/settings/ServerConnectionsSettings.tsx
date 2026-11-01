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
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import {
  peerConnectionsApi,
  type PeerConnectionActivity,
} from "../../api/peerConnections";
import { useI18n } from "../../i18n";
import { SettingsSection } from "./SettingsSection";
import { SettingsItem } from "./SettingsItem";
import styles from "./ServerConnectionsSettings.module.css";

function Host({
  identity,
  label,
}: {
  identity: PeerServerIdentity;
  label?: string;
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
          {os} · {identity.architecture}
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
    [newLabel, setNewLabel] = useState("");
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
  const openForm = (peer?: PeerConnectionEntry, reverse = false) => {
    if (!supportsRefresh) {
      setError(t("connectionsRefreshUpdate"));
      return;
    }
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
    detailRequest.current = peer.serverId;
    setDetails(peer.serverId);
    setNewLabel(peer.label ?? peer.identity?.hostname ?? "");
    setActivity(undefined);
    try {
      const result = await peerConnectionsApi.activity(peer.serverId);
      if (detailRequest.current === peer.serverId) setActivity(result);
    } catch {
      if (detailRequest.current === peer.serverId)
        setError(t("connectionsActivityError"));
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
  if (!data)
    return <p role={error ? "alert" : "status"}>{error || t("loading")}</p>;
  return (
    <div className={styles.root}>
      <SettingsSection
        title={t("connectionsThisServer")}
        description={t("settingsServerConnectionsDescription")}
        doc={{
          path: "topics/peer-access.md#server-connections-settings",
          label: t("settingsServerConnectionsTitle"),
        }}
      >
        <Host identity={data.identity} />
        <SettingsItem
          label={t("connectionsEnabled")}
          description={
            data.environmentOverride === null
              ? t("connectionsEnabledHint")
              : t("connectionsEnvironmentHint")
          }
          as="label"
        >
          <input
            type="checkbox"
            checked={data.enabled}
            disabled={busy || data.environmentOverride !== null}
            onChange={(e) =>
              void act(() => peerConnectionsApi.enabled(e.target.checked))
            }
          />
        </SettingsItem>
      </SettingsSection>
      {!supportsRefresh && (
        <p className={styles.feedback}>{t("connectionsRefreshUpdate")}</p>
      )}
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
      <SettingsSection
        title={t("settingsServerConnectionsTitle")}
        description={t("connectionsTrustHint")}
      >
        <div className={styles.actions}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              busy || !supportsRefresh || data.environmentOverride === false
            }
            onClick={() => openForm()}
          >
            {t("connectionsAdd")}
          </button>
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
        </div>
        {form && (
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <h3>{renew ? t("connectionsRenewTitle") : t("connectionsAdd")}</h3>
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
            {renew && (
              <p className={styles.muted}>{t("connectionsRenewHint")}</p>
            )}
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
                <span className={styles.muted}>
                  {t("connectionsReturnHint")}
                </span>
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
        {!data.peers.length && (
          <p className={styles.empty}>{t("connectionsEmpty")}</p>
        )}
        <div className={styles.peers}>
          {data.peers.map((peer) => (
            <article key={peer.serverId} className={styles.peer}>
              {peer.identity ? (
                <Host identity={peer.identity} label={peer.label} />
              ) : (
                <strong>{peer.label ?? t("connectionsUnknownHost")}</strong>
              )}
              <div className={styles.directions}>
                <span>
                  {t("connectionsOutgoing")}:{" "}
                  {peer.outgoing.some((p) => p.active)
                    ? t("connectionsConfigured")
                    : t("connectionsNone")}
                </span>
                <span>
                  {t("connectionsIncoming")}:{" "}
                  {peer.incoming.some((p) => p.active)
                    ? t("connectionsAllowed")
                    : t("connectionsNone")}
                </span>
              </div>
              {(peer.outgoing.length > 0 || peer.incoming.length > 0) && (
                <p className={styles.muted}>
                  {authenticationText(
                    peer.outgoing.find((p) => p.selected) ??
                      peer.outgoing[0] ??
                      peer.incoming[0]!,
                  )}
                </p>
              )}
              <p className={styles.muted}>
                {peer.verifiedAt
                  ? t("connectionsLastVerified", {
                      date: new Date(peer.verifiedAt).toLocaleString(),
                    })
                  : t("connectionsNeverVerified")}
                {peer.lastOutcome === "partial" &&
                  ` · ${t("connectionsPartialShort")}`}
                {peer.lastOutcome === "uncertain" &&
                  ` · ${t("connectionsUncertainShort")}`}
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  aria-expanded={details === peer.serverId}
                  onClick={() => void showDetails(peer)}
                >
                  {t("connectionsDetails")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !peer.outgoing.some((p) => p.active)}
                  onClick={() =>
                    void act(
                      () => peerConnectionsApi.test(peer.serverId),
                      t("connectionsTestPassed"),
                    )
                  }
                >
                  {t("connectionsTest")}
                </button>
                {peer.outgoing.some(
                  (p) =>
                    p.selected &&
                    p.authentication?.status === "sign-in-required",
                ) && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={
                      busy ||
                      !supportsRefresh ||
                      data.environmentOverride === false
                    }
                    onClick={() => openForm(peer)}
                  >
                    {t("connectionsSignInAgain")}
                  </button>
                )}
              </div>
              {details === peer.serverId && (
                <div className={styles.detail}>
                  <div className={styles.identifier}>
                    <span>{t("connectionsServerId")}</span>
                    <code>{peer.serverId}</code>
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(() =>
                        peerConnectionsApi.label(peer.serverId, newLabel),
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
                    peer[direction].map((credential) => (
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
                          {credential.origin === "fleet"
                            ? t("connectionsFleet")
                            : credential.allProjects
                              ? t("connectionsTrustedControl")
                              : t("connectionsScoped")}{" "}
                          ·{" "}
                          {credential.authentication?.mode === "automatic"
                            ? t("connectionsAutomatic")
                            : t("connectionsExpires", {
                                date: new Date(
                                  credential.expiresAt,
                                ).toLocaleString(),
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
                              void act(
                                () =>
                                  peerConnectionsApi.remove(
                                    peer.serverId,
                                    direction,
                                    credential.credentialId,
                                    credential.generation,
                                  ),
                                direction === "incoming"
                                  ? t("connectionsRevoked")
                                  : t("connectionsStopped"),
                              )
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
                    disabled={
                      busy ||
                      !supportsRefresh ||
                      data.environmentOverride === false
                    }
                    onClick={() => openForm(peer)}
                  >
                    {t("connectionsRenew")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      busy ||
                      !supportsRefresh ||
                      data.environmentOverride === false
                    }
                    onClick={() => openForm(peer, true)}
                  >
                    {t("connectionsReverse")}
                  </button>
                  <h4>{t("connectionsSessions")}</h4>
                  {!activity ? (
                    <p>{t("loading")}</p>
                  ) : (
                    <>
                      {!activity.incoming.length &&
                        !activity.outgoing.length && (
                          <p className={styles.muted}>
                            {t("connectionsNoSessions")}
                          </p>
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
                    .filter((event) => event.serverId === peer.serverId)
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
              )}
            </article>
          ))}
        </div>
        <div className={styles.actions}>
          {cursor !== "0" && (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => setCursor("0")}
            >
              {t("connectionsFirstPage")}
            </button>
          )}
          {data.nextCursor && (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => setCursor(data.nextCursor!)}
            >
              {t("connectionsMore")}
            </button>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
