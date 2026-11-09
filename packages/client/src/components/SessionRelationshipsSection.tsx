import type {
  SessionRelationshipEndpoint,
  SessionRelationshipPage,
} from "@yep-anywhere/shared";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useSessionRelationships } from "../hooks/useSessionRelationships";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useSessionCollectionRecord } from "../lib/clientSummaryStore";
import { providerChildSessionHref } from "../lib/providerChildSessions";
import { getProvider } from "../providers/registry";
import styles from "./SessionRelationshipsSection.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";

const LABELS: Record<string, readonly [string, string]> = {
  created_session: ["relationshipCreated", "relationshipCreatedBy"],
  provider_child: ["relationshipSubagent", "relationshipParent"],
  forked_from: ["relationshipForkedFrom", "relationshipFork"],
  cloned_from: ["relationshipClonedFrom", "relationshipClone"],
  derived_from: ["relationshipDerivedFrom", "relationshipDerived"],
  aside_of: ["relationshipAsideOf", "relationshipAside"],
  continued_from: ["relationshipContinuedFrom", "relationshipContinuation"],
  launched_harness: ["relationshipLaunched", "relationshipLaunchedBy"],
};
const TRUST = {
  "local-authenticated": "relationshipTrustLocal",
  "peer-attested": "relationshipTrustPeer",
  "provider-observed": "relationshipTrustProvider",
  "command-observed": "relationshipTrustCommand",
} as const;

function endpointHref(
  base: string,
  endpoint: SessionRelationshipEndpoint,
  type: string,
): string | undefined {
  if (endpoint.kind === "session")
    return `${base.replace(/\/$/, "")}/projects/${encodeURIComponent(endpoint.projectId)}/sessions/${encodeURIComponent(endpoint.sessionId)}`;
  if (endpoint.kind === "provider-child" && type === "provider_child")
    return providerChildSessionHref(
      base,
      endpoint.projectId,
      endpoint.parentSessionId,
      endpoint.childId,
    );
  // An unfamiliar predicate cannot acquire native-child navigation semantics.
  return undefined;
}

function RelationshipRow({
  row,
  sessionId,
  onNavigate,
}: {
  row: SessionRelationshipPage["relationships"][number];
  sessionId: string;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const base = useRemoteBasePath();
  const outgoing =
    row.source.kind === "session" && row.source.sessionId === sessionId;
  const other = outgoing ? row.target : row.source;
  const summary = useSessionCollectionRecord(
    other.kind === "session" ? other.sessionId : null,
  );
  const proof = row.evidence.reduce<(typeof row.evidence)[number] | undefined>(
    (latest, entry) =>
      !latest || entry.observedAt > latest.observedAt ? entry : latest,
    undefined,
  );
  const id =
    other.kind === "session"
      ? other.sessionId
      : other.kind === "provider-child"
        ? other.childId
        : undefined;
  const title =
    summary?.customTitle ||
    summary?.title ||
    (outgoing ? proof?.title || proof?.agentType : undefined) ||
    id ||
    t("sessionRelationshipsUnknownTarget");
  const label = LABELS[row.type]?.[outgoing ? 0 : 1];
  const href = endpointHref(base, other, row.type);
  const trustLabel =
    proof && Object.hasOwn(TRUST, proof.trust) ? TRUST[proof.trust] : undefined;
  return (
    <li className={styles.row}>
      <span className={styles.predicate}>
        {label ? t(label as never) : row.type}
      </span>
      {href ? (
        <Link
          className={styles.link}
          to={href}
          onClick={(event) => {
            if (
              !event.defaultPrevented &&
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            )
              onNavigate?.();
          }}
        >
          {title}
        </Link>
      ) : (
        <span className={styles.target}>{title}</span>
      )}
      <span className={styles.proof}>
        {typeof other.provider === "string"
          ? getProvider(other.provider).displayName
          : null}
        {proof && (
          <>
            {" "}
            {trustLabel && <>· {t(trustLabel)} </>}·{" "}
            <time dateTime={proof.observedAt}>
              {new Date(proof.observedAt).toLocaleString()}
            </time>
          </>
        )}
      </span>
    </li>
  );
}

/** Mounted by Session Info only after its source capability/authority resolves. */
function SessionRelationshipsPage({
  projectId,
  sessionId,
  onNavigate,
}: {
  projectId: string;
  sessionId: string;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const { page, loading, error, refetch } = useSessionRelationships(
    projectId,
    sessionId,
    cursor,
  );
  const refresh = () => {
    if (cursor) setCursors([]);
    else void refetch();
  };
  return (
    <section
      className={styles.root}
      aria-label={t("sessionRelationshipsTitle")}
    >
      <div className={styles.heading}>
        <h3 className={styles.title}>{t("sessionRelationshipsTitle")}</h3>
        <Button onClick={refresh} disabled={loading}>
          {t("sessionRelationshipsRefresh")}
        </Button>
      </div>
      <p className={styles.note}>{t("sessionRelationshipsCoverage")}</p>
      {loading && !page && (
        <p className={styles.note} role="status">
          {t("sessionRelationshipsLoading")}
        </p>
      )}
      {error && (
        <Banner tone="error" role="status" compact>
          {t("sessionRelationshipsUnavailable")}
        </Banner>
      )}
      {page && (
        <>
          {page.relationships.length ? (
            <ul className={styles.list}>
              {page.relationships.map((row, index) => (
                <RelationshipRow
                  key={JSON.stringify([
                    row.type,
                    row.source,
                    row.target,
                    index,
                  ])}
                  row={row}
                  sessionId={sessionId}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          ) : (
            <p className={styles.note}>{t("sessionRelationshipsEmpty")}</p>
          )}
          {(cursor || page.nextCursor) && (
            <nav
              className={styles.paging}
              aria-label={t("sessionRelationshipsPages")}
            >
              <Button
                disabled={loading || !cursor}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}
              >
                {t("sessionRelationshipsPrevious")}
              </Button>
              <span className={styles.note}>
                {t("sessionRelationshipsPage", { page: cursors.length + 1 })}
              </span>
              <Button
                disabled={loading || !page.nextCursor}
                onClick={() => {
                  if (page.nextCursor)
                    setCursors((previous) => [...previous, page.nextCursor!]);
                }}
              >
                {t("sessionRelationshipsNext")}
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

export function SessionRelationshipsSection(props: {
  projectId: string;
  sessionId: string;
  onNavigate?: () => void;
}) {
  const { sourceKey } = useCurrentSourceRuntime();
  return (
    <SessionRelationshipsPage
      key={JSON.stringify([sourceKey, props.projectId, props.sessionId])}
      {...props}
    />
  );
}
