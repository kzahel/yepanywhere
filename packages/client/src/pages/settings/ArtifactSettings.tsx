import type {
  ArtifactVhost,
  ArtifactVhostLinkedFiles,
  ArtifactVhostSite,
  ArtifactVhostSiteView,
  ArtifactViewerStatus,
} from "@yep-anywhere/shared";
import { useEffect, useId, useRef, useState } from "react";
import { vhostOauthPolicy } from "@yep-anywhere/shared";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsSection } from "./SettingsSection";
import styles from "./ArtifactSettings.module.css";
import { useVhostAccess } from "../../hooks/useVhostAccess";
import { sessionVhostApp } from "../../lib/sessionVhostApps";
import { writeClipboardText } from "../../lib/clipboard";
import { ProjectAppInventorySection } from "./ProjectAppInventorySection";
import { SettingsCollection } from "./SettingsCollection";
import { ElidedPath } from "../../components/ui/ElidedPath";
import { SettingsSortHeader, useSettingsTableSort } from "./SettingsTableSort";
import { ResourceContextMenu } from "../../components/FileResourceActions";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { toBrowserAppHref } from "../../lib/appHref";
import { useVhostOauth } from "../../hooks/useVhostOauth";
import {
  VhostOauthEmails,
  VhostOauthLogs,
  VhostOauthProviderSettings,
} from "./VhostOauthSettings";

/**
 * One row of the vhost table. Port and file rows are saved to separate lists,
 * so a server or client that predates file rows never sees one as a port row.
 */
export type VhostDraft =
  | (ArtifactVhost & { kind: "port" })
  | (ArtifactVhostSite & { kind: "files" });
type EditableVhost = VhostDraft & { id: number };

export function vhostDrafts(status: {
  vhosts?: ArtifactVhost[];
  vhostSites?: ArtifactVhostSite[];
}): VhostDraft[] {
  return [
    ...(status.vhosts ?? []).map((row) => ({ ...row, kind: "port" as const })),
    ...(status.vhostSites ?? []).map((row) => ({
      ...row,
      kind: "files" as const,
    })),
  ];
}

/** A row as last saved, which is the one its link and revocation name. */
function savedRow(status: ArtifactViewerStatus, row: VhostDraft): boolean {
  return row.kind === "files"
    ? !!status.vhostSites?.some(
        (saved) => saved.name === row.name && saved.path === row.path,
      )
    : !!status.vhosts?.some(
        (saved) => saved.name === row.name && saved.port === row.port,
      );
}

/**
 * A file row's address: public when a public root is configured, else the
 * local name; a private row carries its app bearer.
 */
export function vhostSiteUrl(
  row: Pick<ArtifactVhostSite, "name" | "public">,
  status: Pick<ArtifactViewerStatus, "vhostPublicRoot" | "localOrigin">,
  tokens: Record<string, string | null> | undefined,
): string | undefined {
  let url: URL;
  if (status.vhostPublicRoot) {
    url = new URL(`https://${row.name}.${status.vhostPublicRoot}/`);
  } else if (status.localOrigin) {
    url = new URL(status.localOrigin);
    url.hostname = `${row.name}.localhost`;
    url.pathname = "/";
  } else return;
  if (!row.public) {
    const token = tokens?.[row.name];
    if (!token) return;
    url.searchParams.set("ya_access", token);
  }
  return url.href;
}

/** Linked paths a row's tooltip lists before summarizing the rest. */
const LINKED_FILE_TOOLTIP_LINES = 20;

/**
 * How the server sees each saved file row (what it is, what it links to), by
 * row name. Refetched whenever the saved rows change; absent until the server
 * answers, and on a server without file rows (`savedSites` undefined).
 */
function useSiteViews(
  savedSites: ArtifactVhostSite[] | undefined,
): Record<string, ArtifactVhostSiteView> {
  const { transport } = useCurrentSourceRuntime();
  const [views, setViews] = useState<Record<string, ArtifactVhostSiteView>>({});
  useEffect(() => {
    if (!savedSites?.length) return;
    let cancelled = false;
    transport
      .fetch<{ sites: ArtifactVhostSiteView[] }>("/artifacts/vhost-sites")
      .then(
        ({ sites }) => {
          if (cancelled) return;
          setViews(Object.fromEntries(sites.map((site) => [site.name, site])));
        },
        // Views only annotate rows; rows work without them.
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [savedSites, transport]);
  return views;
}

/** The authenticated YA file viewer for an absolute server path. */
function fileViewerHref(basePath: string, path: string): string {
  const query = new URLSearchParams({ mode: "interactive", path });
  return new URL(
    toBrowserAppHref(`${basePath}/file-view?${query}`),
    window.location.href,
  ).href;
}

/**
 * An icon link: a click opens `url` in a new tab, and a right-click (or a
 * touch long press) offers Open and Copy link. Clicks stay off the row.
 */
function LinkIcon({
  url,
  label,
  kind,
  onCopied,
}: {
  url: string;
  label: string;
  kind: "service" | "file";
  onCopied: (copied: boolean) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <a
        className={styles.linkIcon}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={label}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span className={styles.linkIconLabel}>{label}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {kind === "service" ? (
            <>
              <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.1-2.1a3 3 0 0 0-4.2-4.2l-.9.9" />
              <path d="M9.5 6.5a3 3 0 0 0-4.2 0L3.2 8.6a3 3 0 0 0 4.2 4.2l.9-.9" />
            </>
          ) : (
            <>
              <path d="M9 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6Z" />
              <path d="M9 1.5V6h4.5M5.5 9h5M5.5 11.5h3" />
            </>
          )}
        </svg>
      </a>
      {menu && (
        <ResourceContextMenu
          x={menu.x}
          y={menu.y}
          canStartNewSession={false}
          onClose={() => setMenu(null)}
          onOpen={() => window.open(url, "_blank", "noopener,noreferrer")}
          onCopyLink={() => void writeClipboardText(url).then(onCopied)}
        />
      )}
    </>
  );
}

function linkedFilesTooltip(
  linked: ArtifactVhostLinkedFiles,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const shown = linked.paths.slice(0, LINKED_FILE_TOOLTIP_LINES);
  const more = linked.count - shown.length;
  return [
    ...shown,
    ...(more > 0 ? [t("artifactVhostLinkedFilesMore", { count: more })] : []),
  ].join("\n");
}

export function ArtifactSettings() {
  const { sourceKey } = useCurrentSourceRuntime();
  const { version, refetch } = useVersion();
  const status = version?.artifactViewer;
  // Metadata is also present when serving is disabled; old servers expose no form.
  return status ? (
    <ArtifactSettingsForm key={sourceKey} status={status} onSaved={refetch} />
  ) : null;
}

function ArtifactSettingsForm({
  status,
  onSaved,
}: {
  status: ArtifactViewerStatus;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const access = useVhostAccess(status);
  const oauth = useVhostOauth();
  const [logHost, setLogHost] = useState<string | null>(null);
  const [oauthFocus, setOauthFocus] = useState(0);
  const expiryId = useId();
  const [localEnabled, setLocalEnabled] = useState(!!status.localOrigin);
  const [localOrigin, setLocalOrigin] = useState(
    status.localOrigin ?? status.defaultLocalOrigin,
  );
  const [publicOrigin, setPublicOrigin] = useState(status.publicOrigin ?? "");
  const [port, setPort] = useState(String(status.port));
  const [expiryHours, setExpiryHours] = useState(status.expiryHours);
  const [expiryDays, setExpiryDays] = useState(status.expiryDays);
  const [vhostPublicRoot, setVhostPublicRoot] = useState(
    status.vhostPublicRoot ?? "",
  );
  const [alwaysRewriteVhostLinks, setAlwaysRewriteVhostLinks] = useState(
    status.alwaysRewriteVhostLinks === true,
  );
  const [vhosts, setVhosts] = useState<EditableVhost[]>(() =>
    vhostDrafts(status).map((row, id) => ({ ...row, id })),
  );
  const nextRowId = useRef(vhosts.length);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = vhosts.find((row) => row.id === selectedId);
  const tableSort = useSettingsTableSort<"domain" | "serves" | "access">();
  const accessLabel = (row: VhostDraft) =>
    t(
      vhostOauthPolicy(oauth.status?.policies, row.name) !== undefined
        ? "vhostOauthRequired"
        : row.public
          ? row.kind === "files" && (row.passwordProtected || row.password)
            ? "settingsCollectionPassword"
            : "settingsCollectionPublic"
          : "settingsCollectionPrivate",
    );
  const oauthBlocked = (row: VhostDraft) =>
    oauth.status &&
    vhostOauthPolicy(oauth.status.policies, row.name) !== undefined &&
    (!oauth.status.configured || oauth.status.enabled === false);
  const displayedVhosts = tableSort.sortedRows(vhosts, (row, column) => {
    if (column === "domain") return row.name;
    if (column === "access") return accessLabel(row);
    return row.kind === "files" ? row.path : row.port;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const vhostsSupported = status.vhosts !== undefined;
  const sitesSupported = status.vhostSites !== undefined;
  const siteViews = useSiteViews(status.vhostSites);
  const basePath = useRemoteBasePath();
  /** A saved row's service link; undefined while unsaved or unauthorized. */
  const rowUrl = (row: VhostDraft) =>
    !savedRow(status, row)
      ? undefined
      : vhostOauthPolicy(oauth.status?.policies, row.name) !== undefined &&
          status.vhostPublicRoot
        ? `https://${row.name}.${status.vhostPublicRoot}/`
        : row.kind === "files"
          ? vhostSiteUrl(row, status, access.config?.accessTokens)
          : sessionVhostApp(
              `http://localhost:${row.port}/`,
              access.config,
              window.location.href,
              status.vhostPublicRoot ? "public" : undefined,
            )?.url;
  /** A saved file row's viewer link, for a row serving one existing file. */
  const viewerUrl = (row: VhostDraft) =>
    row.kind === "files" &&
    savedRow(status, row) &&
    siteViews[row.name]?.kind === "file"
      ? fileViewerHref(basePath, siteViews[row.name]!.path)
      : undefined;
  const reportCopy = (copied: boolean) =>
    setMessage(t(copied ? "fileViewerCopied" : "viewerCopyLinkFailed"));
  const pending = useRef(Promise.resolve());
  const saveRevision = useRef(0);
  const lastPayload = useRef<string | undefined>(undefined);

  async function save(
    overrides: Partial<{
      localEnabled: boolean;
      expiryDays: number;
      expiryHours: number;
      vhosts: VhostDraft[];
      alwaysRewriteVhostLinks: boolean;
    }> = {},
  ) {
    if (status.locked) return;
    const draft = {
      localEnabled,
      expiryDays,
      expiryHours,
      vhosts,
      alwaysRewriteVhostLinks,
      ...overrides,
    };
    setMessage("");
    try {
      const origins = [
        draft.localEnabled ? localOrigin : "",
        publicOrigin,
      ].filter(Boolean);
      if (
        origins.some(
          (value) => new URL(value).hostname === window.location.hostname,
        )
      ) {
        throw new Error(t("artifactSeparateHost"));
      }
      const body = JSON.stringify({
        port: Number(port),
        localOrigin: draft.localEnabled ? localOrigin.trim() : "",
        publicOrigin: publicOrigin.trim(),
        // A server that reports days takes days; an older one keeps hours.
        ...(draft.expiryDays === undefined
          ? { expiryHours: draft.expiryHours }
          : { expiryDays: draft.expiryDays }),
        ...(vhostsSupported
          ? {
              vhostPublicRoot: vhostPublicRoot.trim(),
              alwaysRewriteVhostLinks: draft.alwaysRewriteVhostLinks,
              vhosts: draft.vhosts.flatMap((row) =>
                row.kind === "port"
                  ? [
                      {
                        name: row.name.trim(),
                        port: row.port,
                        ...(row.env?.trim() ? { env: row.env.trim() } : {}),
                        ...(access.supported
                          ? { public: row.public === true }
                          : {}),
                      },
                    ]
                  : [],
              ),
              ...(sitesSupported
                ? {
                    vhostSites: draft.vhosts.flatMap((row) =>
                      row.kind === "files"
                        ? [
                            {
                              name: row.name.trim(),
                              path: row.path.trim(),
                              public: row.public === true,
                              // Absent keeps the saved password.
                              ...(row.password === undefined
                                ? {}
                                : { password: row.password }),
                            },
                          ]
                        : [],
                    ),
                  }
                : {}),
            }
          : {}),
      });
      if (body === lastPayload.current) return;
      lastPayload.current = body;
      const revision = ++saveRevision.current;
      setSaving(true);
      const operation = pending.current.then(async () => {
        await transport.fetch("/artifacts/config", { method: "PUT", body });
        await onSaved();
      });
      pending.current = operation.catch(() => {});
      try {
        await operation;
        // A saved password is sent once; afterward the row only reports it.
        setVhosts((current) =>
          current.map((row) =>
            row.kind === "files" && row.password !== undefined
              ? {
                  ...row,
                  password: undefined,
                  passwordProtected: row.password !== "",
                }
              : row,
          ),
        );
        if (revision === saveRevision.current) setMessage(t("artifactSaved"));
      } catch (error) {
        if (revision === saveRevision.current) {
          lastPayload.current = undefined;
          setMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (revision === saveRevision.current) setSaving(false);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <SettingsSection
      title={t("artifactSettingsTitle")}
      description={t("artifactSettingsDescription")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p>{t("appsSettingsAutosave")}</p>
      <fieldset className={styles.fields} disabled={status.locked}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => {
              setLocalEnabled(e.target.checked);
              void save({ localEnabled: e.target.checked });
            }}
          />
          {t("artifactLocalEnabled")}
        </label>
        {localEnabled && (
          <label>
            {t("artifactLocalOrigin")}
            <input
              type="url"
              value={localOrigin}
              onBlur={() => void save()}
              onChange={(e) => setLocalOrigin(e.target.value)}
            />
          </label>
        )}
        <label>
          {t("artifactPublicOrigin")}
          <input
            type="url"
            value={publicOrigin}
            onBlur={() => void save()}
            onChange={(e) => setPublicOrigin(e.target.value)}
          />
        </label>
        <p>{t("artifactPublicHint")}</p>
        <label>
          {t("artifactPort")}
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onBlur={() => void save()}
            onChange={(e) => setPort(e.target.value)}
          />
        </label>
        <p>{t("artifactPortHint")}</p>
        {expiryDays !== undefined ? (
          <>
            <div className={styles.expiry}>
              <label htmlFor={expiryId}>{t("artifactExpiryDaysLabel")}</label>
              <CommittedRangeNumberInput
                id={expiryId}
                min={1}
                max={30}
                step={1}
                value={expiryDays}
                ariaLabel={t("artifactExpiryDaysLabel")}
                onCommit={(value) => {
                  setExpiryDays(value);
                  void save({ expiryDays: value });
                }}
              />
            </div>
            <p>{t("artifactExpiryDaysHint")}</p>
            {/* No control: expiry deletion is what a capture asks for when it
                creates its link, so there is nothing here to set. */}
            <p>{t("artifactDeleteOnExpiryHint")}</p>
          </>
        ) : (
          expiryHours !== undefined && (
            <>
              <div className={styles.expiry}>
                <label htmlFor={expiryId}>{t("artifactExpiryLabel")}</label>
                <CommittedRangeNumberInput
                  id={expiryId}
                  min={1}
                  max={168}
                  step={1}
                  value={expiryHours}
                  ariaLabel={t("artifactExpiryLabel")}
                  onCommit={(value) => {
                    setExpiryHours(value);
                    void save({ expiryHours: value });
                  }}
                />
              </div>
              <p>{t("artifactExpiryHint")}</p>
            </>
          )
        )}
        {vhostsSupported && (
          <>
            <label>
              {t("artifactVhostPublicRoot")}
              <input
                type="text"
                value={vhostPublicRoot}
                onBlur={() => void save()}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setVhostPublicRoot(e.target.value)}
              />
            </label>
            <p>{t("artifactVhostPublicRootHint", { port })}</p>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={alwaysRewriteVhostLinks}
                onChange={(event) => {
                  setAlwaysRewriteVhostLinks(event.target.checked);
                  void save({
                    alwaysRewriteVhostLinks: event.target.checked,
                  });
                }}
              />
              {t("artifactAlwaysRewriteVhostLinks")}
            </label>
            <p>{t("artifactAlwaysRewriteVhostLinksHint")}</p>
          </>
        )}
      </fieldset>
      {oauth.supported && oauth.status && (
        <details className={styles.provider}>
          <summary>{t("vhostOauthProvider")}</summary>
          <VhostOauthProviderSettings
            status={oauth.status}
            update={oauth.update}
            multipleProviders={oauth.multipleProviders}
          />
        </details>
      )}
      {oauth.error && <p role="alert">{oauth.error}</p>}
      {logHost !== null && (
        <VhostOauthLogs
          host={logHost || undefined}
          onClose={() => setLogHost(null)}
        />
      )}
      {vhostsSupported && (
        <div className={styles.fields}>
          <div className={styles.vhosts}>
            <div className={styles.vhostHeader}>
              <h3 className={styles.vhostHeading}>
                {t("artifactVhostTableTitle")}
              </h3>
              {oauth.status && (
                <button type="button" onClick={() => setLogHost("")}>
                  {t("vhostOauthAllLogs")}
                </button>
              )}
            </div>
            <div className={styles.vhostIntro}>
              <p>{t("artifactVhostTableHint")}</p>
              {sitesSupported && <p>{t("artifactVhostFilesHint")}</p>}
              <p>
                {t(access.supported ? "appAccessHint" : "appAccessUnavailable")}
              </p>
            </div>
            {access.error && <p role="alert">{access.error}</p>}
            <SettingsCollection
              selectedKey={selectedId}
              title={selected?.name || t("artifactVhostAdd")}
              onClose={() => setSelectedId(null)}
              detail={vhosts.map(
                (row, index) =>
                  row.id === selectedId && (
                    <fieldset
                      key={row.id}
                      className={styles.vhostRow}
                      disabled={status.locked}
                    >
                      <label>
                        {t("artifactVhostName")}
                        <input
                          type="text"
                          value={row.name}
                          onBlur={() => void save()}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) =>
                            setVhosts((current) =>
                              current.map((item, i) =>
                                i === index
                                  ? { ...item, name: e.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      {sitesSupported && (
                        <label>
                          {t("artifactVhostServes")}
                          <select
                            value={row.kind}
                            onChange={(e) => {
                              const kind = e.target.value as VhostDraft["kind"];
                              const next = vhosts.map(
                                (item, i): EditableVhost => {
                                  if (i !== index || item.kind === kind)
                                    return item;
                                  const shared = {
                                    id: item.id,
                                    name: item.name,
                                    ...(item.public === undefined
                                      ? {}
                                      : { public: item.public }),
                                  };
                                  return kind === "files"
                                    ? { ...shared, kind, path: "" }
                                    : { ...shared, kind, port: 19432 };
                                },
                              );
                              setVhosts(next);
                            }}
                          >
                            <option value="port">
                              {t("artifactVhostServesPort")}
                            </option>
                            <option value="files">
                              {t("artifactVhostServesFiles")}
                            </option>
                          </select>
                        </label>
                      )}
                      {row.kind === "files" ? (
                        <label className={styles.pathField}>
                          {t("artifactVhostPath")}
                          <span className={styles.withLinkIcon}>
                            <input
                              type="text"
                              value={row.path}
                              onBlur={() => void save()}
                              placeholder="~/site/index.html"
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(e) =>
                                setVhosts((current) =>
                                  current.map((item, i) =>
                                    i === index && item.kind === "files"
                                      ? { ...item, path: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                            {viewerUrl(row) && (
                              <LinkIcon
                                kind="file"
                                url={viewerUrl(row)!}
                                label={t("artifactVhostOpenInFileViewer")}
                                onCopied={reportCopy}
                              />
                            )}
                          </span>
                        </label>
                      ) : (
                        <>
                          <label>
                            {t("artifactVhostPort")}
                            <input
                              type="number"
                              min={1}
                              max={65535}
                              value={row.port || ""}
                              onBlur={() => void save()}
                              onChange={(e) =>
                                setVhosts((current) =>
                                  current.map((item, i) =>
                                    i === index && item.kind === "port"
                                      ? {
                                          ...item,
                                          port: Number(e.target.value),
                                        }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </label>
                          <label>
                            {t("artifactVhostEnv")}
                            <input
                              type="text"
                              value={row.env ?? ""}
                              onBlur={() => void save()}
                              placeholder="PLANNOTATOR_PORT"
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(e) =>
                                setVhosts((current) =>
                                  current.map((item, i) =>
                                    i === index && item.kind === "port"
                                      ? { ...item, env: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </label>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const next = vhosts.filter((_, i) => i !== index);
                          setVhosts(next);
                          setSelectedId(null);
                          void save({ vhosts: next });
                        }}
                      >
                        {t("artifactVhostRemove")}
                      </button>
                      {oauth.status && savedRow(status, row) && (
                        <VhostOauthEmails
                          key={row.name}
                          name={row.name}
                          status={oauth.status}
                          update={oauth.update}
                          disabled={
                            status.locked ||
                            !status.vhostPublicRoot ||
                            !status.publicOrigin
                          }
                          focusRequest={oauthFocus}
                        />
                      )}
                      {access.supported && (
                        <div className={styles.access}>
                          <label className={styles.toggle}>
                            <input
                              type="checkbox"
                              checked={row.public === true}
                              disabled={
                                vhostOauthPolicy(
                                  oauth.status?.policies,
                                  row.name,
                                ) !== undefined
                              }
                              onChange={(event) => {
                                const next = vhosts.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        public: event.target.checked,
                                      }
                                    : item,
                                );
                                setVhosts(next);
                                void save({ vhosts: next });
                              }}
                            />
                            {t("appAccessPublic")}
                          </label>
                          {row.kind === "files" && row.public && (
                            <div className={styles.password}>
                              <label>
                                {t("artifactVhostPassword")}
                                <input
                                  type="password"
                                  value={row.password ?? ""}
                                  autoComplete="new-password"
                                  placeholder={
                                    row.passwordProtected ? "••••••••" : ""
                                  }
                                  onBlur={() => void save()}
                                  onChange={(e) =>
                                    setVhosts((current) =>
                                      current.map((item, i) =>
                                        i === index && item.kind === "files"
                                          ? {
                                              ...item,
                                              // Emptying the field keeps the
                                              // saved password; Remove clears it.
                                              password:
                                                e.target.value || undefined,
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              {row.passwordProtected && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = vhosts.map((item, i) =>
                                      i === index && item.kind === "files"
                                        ? { ...item, password: "" }
                                        : item,
                                    );
                                    setVhosts(next);
                                    void save({ vhosts: next });
                                  }}
                                >
                                  {t("artifactVhostPasswordClear")}
                                </button>
                              )}
                              <p>
                                {t(
                                  row.passwordProtected
                                    ? "artifactVhostPasswordSet"
                                    : "artifactVhostPasswordHint",
                                )}
                              </p>
                            </div>
                          )}
                          {savedRow(status, row) && (
                            <>
                              <button
                                type="button"
                                disabled={!access.config}
                                onClick={async () => {
                                  const url = rowUrl(row);
                                  reportCopy(
                                    !!url && (await writeClipboardText(url)),
                                  );
                                }}
                              >
                                {t("appAccessCopy")}
                              </button>
                              <button
                                type="button"
                                disabled={saving}
                                onClick={async () => {
                                  setSaving(true);
                                  try {
                                    await transport.fetch(
                                      `/artifacts/vhosts/${encodeURIComponent(row.name)}/revoke`,
                                      { method: "POST" },
                                    );
                                    access.refresh();
                                    setMessage(t("appAccessRevoked"));
                                  } catch (error) {
                                    setMessage(
                                      error instanceof Error
                                        ? error.message
                                        : String(error),
                                    );
                                  } finally {
                                    setSaving(false);
                                  }
                                }}
                              >
                                {t("appAccessRevoke")}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </fieldset>
                  ),
              )}
            >
              <table
                className={styles.table}
                aria-label={t("artifactVhostTableTitle")}
              >
                <thead>
                  <tr>
                    <SettingsSortHeader
                      column="domain"
                      label={t("settingsCollectionDomain")}
                      {...tableSort}
                    />
                    <SettingsSortHeader
                      column="serves"
                      label={t("artifactVhostServes")}
                      {...tableSort}
                    />
                    {access.supported && (
                      <SettingsSortHeader
                        column="access"
                        label={t("settingsCollectionAccess")}
                        {...tableSort}
                      />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {displayedVhosts.map((row) => {
                    const url = rowUrl(row);
                    const linked =
                      row.kind === "files" && savedRow(status, row)
                        ? siteViews[row.name]?.linkedFiles
                        : undefined;
                    return (
                      <tr
                        key={row.id}
                        className={
                          oauthBlocked(row) ? styles.oauthBlocked : undefined
                        }
                      >
                        <td>
                          <div className={styles.domainCell}>
                            <button
                              type="button"
                              aria-expanded={selectedId === row.id}
                              onClick={() =>
                                setSelectedId(
                                  selectedId === row.id ? null : row.id,
                                )
                              }
                            >
                              <span aria-hidden="true">
                                {selectedId === row.id ? "▾" : "▸"}{" "}
                              </span>
                              <span
                                className={styles.domainName}
                                title={row.name || undefined}
                              >
                                {row.name || t("artifactVhostAdd")}
                              </span>
                              {row.name && (
                                <small className={styles.domainSuffix}>
                                  .{vhostPublicRoot || "localhost"}
                                </small>
                              )}
                            </button>
                            {url && (
                              <LinkIcon
                                kind="service"
                                url={url}
                                label={t("artifactVhostOpenLink", {
                                  name: row.name,
                                })}
                                onCopied={reportCopy}
                              />
                            )}
                            {oauth.status?.accessedHosts.includes(
                              `${row.name}.${status.vhostPublicRoot}`,
                            ) && (
                              <button
                                type="button"
                                title={t("vhostOauthHostLogs", {
                                  name: row.name,
                                })}
                                aria-label={t("vhostOauthHostLogs", {
                                  name: row.name,
                                })}
                                onClick={() =>
                                  setLogHost(
                                    `${row.name}.${status.vhostPublicRoot}`,
                                  )
                                }
                              >
                                ◷
                              </button>
                            )}
                          </div>
                        </td>
                        <td>
                          {row.kind === "files" && row.path ? (
                            <ElidedPath path={row.path} />
                          ) : (
                            <span className={styles.target}>
                              {row.kind === "files"
                                ? t("artifactVhostServesFiles")
                                : `:${row.port}`}
                            </span>
                          )}
                          {linked && (
                            <small
                              className={styles.linkedFiles}
                              title={linkedFilesTooltip(linked, t)}
                            >
                              {t(
                                linked.truncated
                                  ? "artifactVhostLinkedFilesTruncated"
                                  : "artifactVhostLinkedFiles",
                                { count: linked.count },
                              )}
                            </small>
                          )}
                        </td>
                        {access.supported && (
                          <td>
                            <button
                              type="button"
                              className={styles.accessButton}
                              onClick={() => {
                                setSelectedId(row.id);
                                setOauthFocus((value) => value + 1);
                              }}
                            >
                              {accessLabel(row)}
                            </button>
                            {oauthBlocked(row) && (
                              <small>{t("vhostOauthBlocked")}</small>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </SettingsCollection>
            <button
              type="button"
              disabled={status.locked}
              onClick={() => {
                const id = nextRowId.current++;
                setVhosts((current) => [
                  ...current,
                  { id, kind: "port", name: "", port: 19432 },
                ]);
                setSelectedId(id);
              }}
            >
              {t("artifactVhostAdd")}
            </button>
          </div>
        </div>
      )}
      <ProjectAppInventorySection />
      {status.locked && <p>{t("artifactLocked")}</p>}
      {saving && <p role="status">{t("artifactSaving")}</p>}
      {message && <p role="status">{message}</p>}
    </SettingsSection>
  );
}
