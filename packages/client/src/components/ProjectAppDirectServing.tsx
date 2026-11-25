import type { ProjectAppInfo } from "@yep-anywhere/shared/project-service";
import { useState } from "react";
import { projectAppApi, type ProjectAppDirectFields } from "../api/projectApp";
import { useI18n } from "../i18n";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";
import styles from "./ProjectAppDirectServing.module.css";

/**
 * An app's redirect address, direct host port and Tailscale Funnel
 * (topics/project-service.md § Direct serving), for a server advertising
 * project-app-direct-serving. The host port and Funnel open a path with no
 * YA access check, so only an administrator edits them, and Settings marks
 * that path Public whenever a port is declared.
 */
export function ProjectAppDirectServing({
  projectId,
  info,
  busy,
  perform,
  onInfo,
}: {
  projectId: string;
  info: ProjectAppInfo;
  busy: boolean;
  perform: (action: () => Promise<void>) => Promise<void> | void;
  onInfo: (info: ProjectAppInfo) => void;
}) {
  const { t } = useI18n();
  const direct = info.direct ?? {};
  const loaded: ProjectAppDirectFields = {
    ...(direct.redirect ? { redirect: direct.redirect } : {}),
    ...(direct.hostPort !== undefined ? { hostPort: direct.hostPort } : {}),
  };
  const processApp = info.declaration?.where.kind === "process";
  const administrator = info.canPublish;
  const canEdit = info.canExecute;
  const [draft, setDraft] = useState<{ redirect: string; port: string } | null>(
    null,
  );
  const [invalid, setInvalid] = useState(false);
  if (!canEdit && !direct.redirect && direct.hostPort === undefined)
    return null;

  const save = (fields: { redirect: string; port: string }) => {
    const redirect = fields.redirect.trim();
    const port = fields.port.trim();
    const next: ProjectAppDirectFields = {
      ...(redirect ? { redirect } : {}),
      ...(port ? { hostPort: Number(port) } : {}),
    };
    if (
      (redirect && !/^https?:\/\/[^\s]+$/i.test(redirect)) ||
      (port &&
        !(/^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535))
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void perform(async () => {
      onInfo(await projectAppApi.setDirect(projectId, loaded, next));
      setDraft(null);
    });
  };
  const funnel = direct.funnel;
  const port = direct.hostPort;

  return (
    <section className={styles.direct}>
      {draft === null ? (
        <div className={styles.summary}>
          <dl className={styles.fields}>
            <dt>{t("projectAppRedirect")}</dt>
            <dd>
              {direct.redirect ? (
                <a href={direct.redirect} target="_blank" rel="noreferrer">
                  {direct.redirect}
                </a>
              ) : (
                <span className={styles.none}>{t("projectAppDirectNone")}</span>
              )}
            </dd>
            {(processApp || port !== undefined) && (
              <>
                <dt>{t("projectAppHostPort")}</dt>
                <dd>
                  {port === undefined ? (
                    <span className={styles.none}>
                      {t("projectAppDirectNone")}
                    </span>
                  ) : (
                    // The warning below, titled Public, marks this path.
                    <code>127.0.0.1:{port}</code>
                  )}
                </dd>
              </>
            )}
          </dl>
          {canEdit && (
            <Button
              variant="ghost"
              size="small"
              disabled={busy}
              onClick={() =>
                setDraft({
                  redirect: direct.redirect ?? "",
                  port: port === undefined ? "" : String(port),
                })
              }
            >
              {t("projectAppCommandEdit")}
            </Button>
          )}
        </div>
      ) : (
        // Not a form: Settings already wraps this panel in one, and the
        // outer form's Enter submission must not reach this editor's fields.
        // Not a fieldset either, which the viewer's details style as a box.
        <div
          role="group"
          aria-label={t("projectAppRedirect")}
          className={styles.editor}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              !(event.target instanceof HTMLInputElement)
            )
              return;
            event.preventDefault();
            save(draft);
          }}
        >
          <Field
            label={t("projectAppRedirect")}
            hint={t("projectAppRedirectHint")}
          >
            <TextInput
              type="url"
              value={draft.redirect}
              placeholder="https://"
              spellCheck={false}
              onChange={(event) =>
                setDraft({ ...draft, redirect: event.target.value })
              }
            />
          </Field>
          {processApp && administrator && (
            <Field
              label={t("projectAppHostPort")}
              hint={t("projectAppHostPortHint")}
            >
              <TextInput
                inputMode="numeric"
                value={draft.port}
                placeholder="3470"
                onChange={(event) =>
                  setDraft({ ...draft, port: event.target.value })
                }
              />
            </Field>
          )}
          {invalid && (
            <p className={styles.state} role="alert">
              {t("projectAppDirectInvalid")}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => save(draft)}
            >
              {t("projectAppCommandSave")}
            </Button>
            <Button disabled={busy} onClick={() => setDraft(null)}>
              {t("projectAppCommandCancel")}
            </Button>
          </div>
        </div>
      )}
      {port !== undefined && (
        <Banner tone="warning" title={t("projectAppHostPortPublic")}>
          {t("projectAppHostPortWarning")}
          {direct.listening && (
            <p className={styles.state}>
              {t("projectAppHostPortListening", { port })}
            </p>
          )}
          {direct.error && <p className={styles.state}>{direct.error}</p>}
        </Banner>
      )}
      {funnel && port !== undefined && (
        <FunnelControls
          funnel={funnel}
          busy={busy}
          onSet={(httpsPort, on) =>
            void perform(async () =>
              onInfo(await projectAppApi.setFunnel(projectId, httpsPort, on)),
            )
          }
        />
      )}
    </section>
  );
}

function FunnelControls({
  funnel,
  busy,
  onSet,
}: {
  funnel: NonNullable<NonNullable<ProjectAppInfo["direct"]>["funnel"]>;
  busy: boolean;
  onSet: (httpsPort: number, on: boolean) => void;
}) {
  const { t } = useI18n();
  const url = (port: number) =>
    port === 443 ? funnel.host : `${funnel.host.replace(/\/$/, "")}:${port}/`;
  const published = new Set(funnel.urls);
  return (
    <div className={styles.funnel}>
      <h4>{t("projectAppFunnel")}</h4>
      {funnel.setupCommand && (
        <p>
          {t("projectAppFunnelSetup")}
          <code className={styles.command}>{funnel.setupCommand}</code>
        </p>
      )}
      {funnel.ports.length === 0 && <p>{t("projectAppFunnelNoPorts")}</p>}
      <ul>
        {funnel.ports.map((port) => {
          const address = url(port);
          return (
            <li key={port}>
              {published.has(address) ? (
                <>
                  <span>
                    {t("projectAppFunnelPublished")}{" "}
                    <a href={address} target="_blank" rel="noreferrer">
                      {address}
                    </a>
                  </span>
                  <Button
                    size="small"
                    disabled={busy || !!funnel.setupCommand}
                    onClick={() => onSet(port, false)}
                  >
                    {t("projectAppFunnelStop")}
                  </Button>
                </>
              ) : funnel.busy.includes(port) ? (
                <span className={styles.none}>
                  {t("projectAppFunnelBusy", { url: address })}
                </span>
              ) : (
                <Button
                  size="small"
                  disabled={busy || !!funnel.setupCommand}
                  onClick={() => onSet(port, true)}
                >
                  {t("projectAppFunnelPublish", { url: address })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
