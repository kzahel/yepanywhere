import type { ArtifactVhostSiteView } from "@yep-anywhere/shared";
import { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import { Badge } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { confirmDialog } from "./ui/ConfirmDialog";
import { Select, TextInput } from "./ui/Field";
import styles from "./FileVhostSection.module.css";

/** The requests the section makes; the File Viewer binds them to its source. */
export interface FileVhostService {
  /** Sites serving exactly `path`. */
  list(path: string): Promise<ArtifactVhostSiteView[]>;
  serve(site: {
    name: string;
    path: string;
    public: boolean;
    password?: string;
    replace?: boolean;
  }): Promise<ArtifactVhostSiteView>;
  stop(name: string): Promise<void>;
  /** Shown after the name field: the public root, or `localhost`. */
  hostSuffix: string;
  canReplace?: boolean;
  canUsePrivateLinks?: boolean;
}

/** A DNS label suggested from the file name; the server still validates. */
export function suggestVhostName(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? "";
  const stem = base.replace(/\.[^.]*$/, "") || base;
  const label = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return label === "index" ? "" : label;
}

/**
 * Serves a file at its own hostname as a file vhost, beside the File Viewer's
 * bearer links. One address per file is offered here; Settings → Apps lists
 * and edits every vhost.
 */
export function FileVhostSection({
  filePath,
  service,
}: {
  filePath: string;
  service: FileVhostService;
}) {
  const { t } = useI18n();
  const id = useId();
  const [sites, setSites] = useState<ArtifactVhostSiteView[] | null>(null);
  const [name, setName] = useState(() => suggestVhostName(filePath));
  const [access, setAccess] = useState<"public" | "password" | "link">(
    "public",
  );
  const [password, setPassword] = useState("");
  const [replace, setReplace] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSites(await service.list(filePath));
    } catch (cause) {
      setSites([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [filePath, service]);

  useEffect(() => {
    void load();
  }, [load]);

  const serve = async () => {
    const label = name.trim().toLowerCase();
    if (!label) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const site = await service.serve({
        name: label,
        path: filePath,
        public: access !== "link",
        ...(access === "password" ? { password } : {}),
        ...(replace ? { replace: true } : {}),
      });
      setPassword("");
      setSites((current) => [
        ...(current ?? []).filter((row) => row.name !== site.name),
        site,
      ]);
      const url = site.publicUrl ?? site.localUrl;
      if (url && (await writeClipboardText(url)))
        setNotice(t("fileVhostCopied"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const stop = async (site: ArtifactVhostSiteView) => {
    if (
      !(await confirmDialog({
        title: t("fileVhostStopConfirmTitle"),
        message: t("fileVhostStopConfirm", { name: site.name }),
        confirmLabel: t("fileVhostStop"),
        tone: "danger",
      }))
    )
      return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await service.stop(site.name);
      setSites((current) =>
        (current ?? []).filter((row) => row.name !== site.name),
      );
      setNotice(t("fileVhostStopped"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby={`${id}-heading`}>
      <strong id={`${id}-heading`} className={styles.heading}>
        {t("fileVhostHeading")}
      </strong>
      <p className={styles.description}>{t("fileVhostDescription")}</p>
      {sites === null ? (
        <p className={styles.description}>{t("fileVhostLoading")}</p>
      ) : sites.length > 0 ? (
        <ul className={styles.sites}>
          {sites.map((site) => {
            const url = site.publicUrl ?? site.localUrl;
            return (
              <li key={site.name} className={styles.site}>
                {url ? (
                  <a
                    className={styles.url}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {displayUrl(url)}
                  </a>
                ) : (
                  <span className={styles.url}>{site.name}</span>
                )}
                <Badge
                  size="small"
                  tone={
                    site.public && !site.passwordProtected
                      ? "accent"
                      : "neutral"
                  }
                  className={styles.siteAccess}
                >
                  {!site.public
                    ? t("fileVhostPrivateBadge")
                    : site.passwordProtected
                      ? t("fileVhostPasswordBadge")
                      : t("fileVhostPublicBadge")}
                </Badge>
                <span className={styles.actions}>
                  {url && (
                    <Button
                      disabled={working}
                      onClick={async () =>
                        setNotice(
                          (await writeClipboardText(url))
                            ? t("fileVhostCopied")
                            : t("viewerCopyLinkFailed"),
                        )
                      }
                    >
                      {t("fileVhostCopy")}
                    </Button>
                  )}
                  <Button disabled={working} onClick={() => void stop(site)}>
                    {t("fileVhostStop")}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {sites !== null && (sites.length === 0 || service.canReplace) && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void serve();
          }}
        >
          <label className={styles.nameField} htmlFor={`${id}-name`}>
            <span className={styles.scheme}>https://</span>
            <input
              id={`${id}-name`}
              className={styles.nameInput}
              aria-label={t("fileVhostName")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={working}
              placeholder={t("fileVhostNamePlaceholder")}
            />
            <span className={styles.suffix}>.{service.hostSuffix}/</span>
          </label>
          <label className={styles.access}>
            {t("fileVhostAccess")}
            <Select
              size="small"
              touchTarget="large"
              value={access}
              onChange={(event) =>
                setAccess(event.target.value as typeof access)
              }
              disabled={working}
            >
              <option value="public">{t("fileVhostAccessPublic")}</option>
              <option value="password">{t("fileVhostAccessPassword")}</option>
              {service.canUsePrivateLinks !== false && (
                <option value="link">{t("fileVhostAccessLink")}</option>
              )}
            </Select>
          </label>
          {access === "password" && (
            <label className={styles.access}>
              {t("fileVhostPassword")}
              <TextInput
                type="password"
                size="small"
                className={styles.passwordInput}
                touchTarget="large"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                disabled={working}
              />
            </label>
          )}
          {service.canReplace && (
            <Checkbox
              className={styles.replace}
              touchTarget="large"
              label={t("fileVhostReplace")}
              checked={replace}
              onCheckedChange={setReplace}
              disabled={working}
            />
          )}
          <Button
            variant="primary"
            type="submit"
            className={styles.submit}
            disabled={
              working || !name.trim() || (access === "password" && !password)
            }
          >
            {working ? t("fileVhostServing") : t("fileVhostServe")}
          </Button>
        </form>
      )}
      {error && (
        <Banner tone="error" compact>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="success" compact>
          {notice}
        </Banner>
      )}
    </section>
  );
}

function displayUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}
