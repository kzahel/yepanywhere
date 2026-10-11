import { useEffect, useRef, useState } from "react";
import {
  redundantVhostEmail,
  vhostOauthPolicy,
  vhostOauthProviderName,
  type VhostOauthLogEntry,
  type VhostOauthStatus,
} from "@yep-anywhere/shared";
import { Modal } from "../../components/ui/Modal";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useI18n } from "../../i18n";
import { downloadBlob } from "../../lib/imageActions";
import { generateUUID } from "../../lib/uuid";
import styles from "./VhostOauthSettings.module.css";

type Update = (
  path: string,
  body: unknown,
  method?: "PUT" | "DELETE",
) => Promise<void>;

const GOOGLE_ISSUER = "https://accounts.google.com";

export function VhostOauthProviderSettings({
  status,
  update,
  multipleProviders = false,
}: {
  status: VhostOauthStatus;
  update: Update;
  multipleProviders?: boolean;
}) {
  const { t } = useI18n();
  const [newId, setNewId] = useState<string>();
  if (!multipleProviders)
    return <ProviderEditor status={status} update={update} />;
  const entries = status.providers ?? [];
  return (
    <div className={styles.settings}>
      <ProviderToggle
        enabled={status.enabled ?? true}
        path="/artifacts/vhosts/oauth/enabled"
        label={t("vhostOauthEnabled")}
        update={update}
      />
      <p>{t("vhostOauthEnabledHint")}</p>
      {entries.map((entry) => (
        <section
          key={entry.id}
          className={styles.providerCard}
          aria-label={vhostOauthProviderName(entry.provider)}
        >
          <ProviderToggle
            enabled={entry.enabled}
            path={`/artifacts/vhosts/oauth/providers/${entry.id}/enabled`}
            label={vhostOauthProviderName(entry.provider)}
            update={update}
          />
          <details>
            <summary>{t("vhostOauthEditProvider")}</summary>
            <ProviderEditor
              status={{ ...status, ...entry, enabled: undefined }}
              update={update}
              id={entry.id}
            />
          </details>
        </section>
      ))}
      {newId && !entries.some((entry) => entry.id === newId) ? (
        <section className={styles.providerCard}>
          <ProviderEditor
            key={newId}
            status={{
              ...status,
              provider: {
                ...status.provider,
                kind: "oidc",
                issuer: GOOGLE_ISSUER,
                clientId: "",
              },
              locked: false,
              secretConfigured: false,
              secretSuffix: undefined,
              enabled: undefined,
            }}
            update={update}
            id={newId}
          />
          <button type="button" onClick={() => setNewId(undefined)}>
            {t("cancel")}
          </button>
        </section>
      ) : (
        entries.length < 8 && (
          <button
            type="button"
            onClick={() =>
              setNewId(entries.length ? generateUUID() : "default")
            }
          >
            {t("vhostOauthAddProvider")}
          </button>
        )
      )}
    </div>
  );
}

function ProviderToggle({
  enabled,
  path,
  label,
  update,
}: {
  enabled: boolean;
  path: string;
  label: string;
  update: Update;
}) {
  const [pending, setPending] = useState<boolean>();
  const [error, setError] = useState("");
  return (
    <div>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={pending ?? enabled}
          disabled={pending !== undefined}
          onChange={async (event) => {
            const value = event.target.checked;
            setPending(value);
            setError("");
            try {
              await update(path, { enabled: value });
            } catch (failure) {
              setError(String(failure));
            } finally {
              setPending(undefined);
            }
          }}
        />
        {label}
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function ProviderEditor({
  status,
  update,
  id,
}: {
  status: VhostOauthStatus;
  update: Update;
  id?: string;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState(status.provider);
  const [secret, setSecret] = useState("");
  const [pendingEnabled, setPendingEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const hasSavedSecret =
    status.secretConfigured &&
    provider.kind === status.provider.kind &&
    provider.clientId === status.provider.clientId &&
    provider.tenantId === status.provider.tenantId &&
    provider.issuer === status.provider.issuer;
  return (
    <div className={styles.settings}>
      {status.enabled !== undefined && (
        <>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={pendingEnabled ?? status.enabled}
              disabled={busy}
              onChange={async (event) => {
                const enabled = event.target.checked;
                setPendingEnabled(enabled);
                setBusy(true);
                setMessage("");
                try {
                  await update("/artifacts/vhosts/oauth/enabled", { enabled });
                } catch (error) {
                  setMessage(String(error));
                } finally {
                  setPendingEnabled(undefined);
                  setBusy(false);
                }
              }}
            />
            {t("vhostOauthEnabled")}
          </label>
          <p>{t("vhostOauthEnabledHint")}</p>
        </>
      )}
      <p>
        {t(status.locked ? "vhostOauthEnvironment" : "vhostOauthProviderHint")}
      </p>
      <fieldset disabled={status.locked || busy} className={styles.fields}>
        <label>
          {t("vhostOauthProvider")}
          <select
            value={
              provider.kind === "oidc" && provider.issuer === GOOGLE_ISSUER
                ? "google"
                : provider.kind
            }
            onChange={(e) =>
              setProvider({
                ...provider,
                kind: e.target.value === "entra" ? "entra" : "oidc",
                issuer: e.target.value === "google" ? GOOGLE_ISSUER : "",
              })
            }
          >
            <option value="entra">Microsoft Entra</option>
            <option value="google">Google</option>
            <option value="oidc">{t("vhostOauthCustomProvider")}</option>
          </select>
        </label>
        {provider.kind === "oidc" && provider.issuer === GOOGLE_ISSUER && (
          <p>{t("vhostOauthGoogleHint")}</p>
        )}
        {provider.kind === "entra" ? (
          <label>
            {t("vhostOauthTenant")}
            <input
              value={provider.tenantId}
              onChange={(e) =>
                setProvider({ ...provider, tenantId: e.target.value })
              }
            />
          </label>
        ) : (
          <label>
            {t("vhostOauthIssuer")}
            <input
              type="url"
              value={provider.issuer}
              onChange={(e) =>
                setProvider({ ...provider, issuer: e.target.value })
              }
            />
          </label>
        )}
        <label>
          {t("vhostOauthClientId")}
          <input
            value={provider.clientId}
            onChange={(e) =>
              setProvider({ ...provider, clientId: e.target.value })
            }
          />
        </label>
        <label>
          {t("vhostOauthCallback")}
          <input
            type="url"
            value={provider.callbackUrl}
            onChange={(e) =>
              setProvider({ ...provider, callbackUrl: e.target.value })
            }
          />
        </label>
        <label>
          {t("vhostOauthSecret")}
          <input
            type="password"
            autoComplete="new-password"
            value={secret}
            placeholder={
              hasSavedSecret ? `••••${status.secretSuffix ?? "••••"}` : ""
            }
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <label>
          {t("vhostOauthIp")}
          <select
            value={provider.visitorIp}
            onChange={(e) =>
              setProvider({
                ...provider,
                visitorIp: e.target.value as typeof provider.visitorIp,
              })
            }
          >
            <option value="peer">{t("vhostOauthIpPeer")}</option>
            <option value="cloudflare">Cloudflare</option>
            <option value="x-real-ip">X-Real-IP</option>
          </select>
        </label>
        <p>{t("vhostOauthIpHint")}</p>
        {!status.locked && (
          <button
            type="button"
            onClick={async () => {
              setBusy(true);
              setMessage("");
              try {
                await update(
                  id
                    ? `/artifacts/vhosts/oauth/providers/${id}`
                    : "/artifacts/vhosts/oauth",
                  {
                    provider,
                    ...(secret ? { secret } : {}),
                  },
                );
                setSecret("");
                setMessage(t("artifactSaved"));
              } catch (error) {
                setMessage(String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("vhostOauthConfigure")}
          </button>
        )}
      </fieldset>
      {id && id !== "default" && status.secretConfigured && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMessage("");
            try {
              await update(
                `/artifacts/vhosts/oauth/providers/${id}`,
                undefined,
                "DELETE",
              );
            } catch (error) {
              setMessage(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("vhostOauthRemoveProvider")}
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function VhostOauthEmails({
  name,
  status,
  update,
  disabled,
  focusRequest,
}: {
  name: string;
  status: VhostOauthStatus;
  update: Update;
  disabled: boolean;
  focusRequest: number;
}) {
  const { t } = useI18n();
  const saved = vhostOauthPolicy(status.policies, name);
  const enabled = saved !== undefined;
  const [rows, setRows] = useState(() =>
    (saved ?? ["*@*"]).map((value, id) => ({ value, id })),
  );
  const nextId = useRef(rows.length);
  const first = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusRequest reselects the first email when the host's access label is clicked again.
  useEffect(() => {
    if (!enabled) return;
    const frame = requestAnimationFrame(() => {
      first.current?.focus();
      first.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, focusRequest]);
  async function persist(emails: string[] | null) {
    setBusy(true);
    setMessage("");
    try {
      await update(`/artifacts/vhosts/${encodeURIComponent(name)}/oauth`, {
        emails,
      });
      setMessage(t("artifactSaved"));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.settings}>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={
            disabled ||
            busy ||
            (!enabled && (!status.configured || status.enabled === false))
          }
          onChange={(e) => {
            void persist(
              e.target.checked ? rows.map((row) => row.value) : null,
            );
            if (e.target.checked)
              requestAnimationFrame(() => {
                first.current?.focus();
                first.current?.select();
              });
          }}
        />
        {t("vhostOauthRequired")}
      </label>
      <p>
        {t(
          enabled && (!status.configured || status.enabled === false)
            ? "vhostOauthBlocked"
            : !status.configured
              ? "vhostOauthConfigureFirst"
              : "vhostOauthLocalExcluded",
        )}
      </p>
      {enabled && (
        <>
          <p>{t("vhostOauthEmailsHint")}</p>
          {rows.map((row, index) => {
            const redundant = redundantVhostEmail(
              rows.map((item) => item.value),
              index,
            );
            return (
              <div key={row.id}>
                <div className={styles.emailRow}>
                  <input
                    ref={index === 0 ? first : undefined}
                    className={redundant ? styles.redundant : undefined}
                    aria-label={t("vhostOauthEmail", { number: index + 1 })}
                    value={row.value}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    onChange={(e) =>
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id
                            ? { ...item, value: e.target.value }
                            : item,
                        ),
                      )
                    }
                    onBlur={() => void persist(rows.map((item) => item.value))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void persist(rows.map((item) => item.value));
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={t("vhostOauthRemoveEmail", {
                      number: index + 1,
                    })}
                    onClick={() => {
                      const next = rows.filter((item) => item.id !== row.id);
                      setRows(next);
                      void persist(next.map((item) => item.value));
                    }}
                  >
                    −
                  </button>
                </div>
                {redundant && (
                  <small className={styles.redundantHint}>
                    {t("vhostOauthRedundant", { email: redundant })}
                  </small>
                )}
              </div>
            );
          })}
          <button
            type="button"
            disabled={disabled || rows.length >= 32}
            onClick={() =>
              setRows((current) => [
                ...current,
                { id: nextId.current++, value: "" },
              ])
            }
          >
            {t("vhostOauthAddEmail")}
          </button>
          {rows.length === 0 && <p>{t("vhostOauthNobody")}</p>}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function VhostOauthLogs({
  host,
  onClose,
}: {
  host?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const [entries, setEntries] = useState<VhostOauthLogEntry[]>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly requests a fresh log snapshot.
  useEffect(() => {
    let cancelled = false;
    transport
      .fetch<{ entries: VhostOauthLogEntry[] }>(
        `/artifacts/vhosts/oauth/log${host ? `?host=${encodeURIComponent(host)}` : ""}`,
      )
      .then(
        (result) => {
          if (!cancelled) setEntries(result.entries);
        },
        (failure: unknown) => {
          if (!cancelled) setError(String(failure));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [host, transport, revision]);
  return (
    <Modal
      title={host ?? t("vhostOauthAllLogs")}
      onClose={onClose}
      actions={
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          {t("vhostOauthRefresh")}
        </button>
      }
    >
      <div className={styles.settings}>
        <p>{t("vhostOauthLogHint")}</p>
        <button
          type="button"
          disabled={!entries?.length}
          onClick={() =>
            downloadBlob(
              new Blob(
                [
                  entries!.map((entry) => JSON.stringify(entry)).join("\n") +
                    "\n",
                ],
                { type: "application/x-ndjson" },
              ),
              "vhost-oauth-access.jsonl",
            )
          }
        >
          {t("vhostOauthDownload")}
        </button>
        {error && <p role="alert">{error}</p>}
        {entries?.length === 0 && <p>{t("vhostOauthNoLogs")}</p>}
        <div className={styles.logEntries}>
          {entries?.map((entry, index) => (
            <article
              key={`${entry.timestamp}:${index}`}
              className={styles.logEntry}
            >
              <time dateTime={entry.timestamp}>
                {new Date(entry.timestamp).toLocaleString()}
              </time>
              <strong>{entry.email ?? "—"}</strong>
              <span>{entry.host}</span>
              <span>
                {t(
                  entry.outcome === "allowed"
                    ? "vhostOauthAllowed"
                    : entry.outcome === "denied"
                      ? "vhostOauthDenied"
                      : "vhostOauthError",
                )}
                {entry.ip ? ` · ${entry.ip}` : ""}
              </span>
            </article>
          ))}
        </div>
      </div>
    </Modal>
  );
}
