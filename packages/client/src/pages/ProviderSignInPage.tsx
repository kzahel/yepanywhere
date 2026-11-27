import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { Banner } from "../components/ui/Banner";
import { useCanAdministerHost } from "../hooks/useActingPrincipal";
import { useProviderRow } from "../hooks/useProviders";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { ProviderSignIn } from "./settings/ProviderSignIn";
import styles from "./ProviderSignInPage.module.css";

/** One focused owner flow for desktop, remote clients and the Android host. */
export function ProviderSignInPage() {
  const { provider: parameter } = useParams();
  const provider =
    parameter === "claude" || parameter === "codex" ? parameter : null;
  const [searchParams] = useSearchParams();
  const hardwareKeyRecovery =
    provider === "codex" && searchParams.get("hardwareKey") === "1";
  const { row, loading, error, refresh, sourceKey } = useProviderRow(provider);
  const canAdminister = useCanAdministerHost();
  const { isWideScreen } = useNavigationLayout();
  const basePath = useRemoteBasePath();
  const { t } = useI18n();
  const name = provider === "claude" ? "Claude" : "Codex";
  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={t("providersSignIn", { provider: name })} />
      <main className={styles.page}>
        <section className={styles.card}>
          <h1>{t("providersSignIn", { provider: name })}</h1>
          <p>{t("providerSignInHostHint")}</p>
          {!provider ? (
            <Banner tone="error">{t("providerSignInUnsupported")}</Banner>
          ) : loading ? (
            <p role="status">{t("providerSignInLoading")}</p>
          ) : error ? (
            <Banner tone="error">{error.message}</Banner>
          ) : row?.authenticated &&
            (provider !== "codex" ||
              !row.supportsInAppLogin ||
              !canAdminister) ? (
            <Banner tone="success">
              {t("providerSignInReady", { provider: name })}
            </Banner>
          ) : row?.supportsInAppLogin && canAdminister ? (
            <>
              {hardwareKeyRecovery && (
                <p>{t("providerSignInCodexHardwareKeyHint")}</p>
              )}
              <ProviderSignIn
                key={`${sourceKey}:${provider}`}
                provider={provider}
                displayName={name}
                supportsHostTerminal={row.supportsHostTerminalLogin === true}
                reauthenticate={provider === "codex" && row.authenticated}
                startLabel={
                  hardwareKeyRecovery
                    ? t("providerSignInStartDevice")
                    : undefined
                }
                onSignedIn={refresh}
              />
            </>
          ) : (
            <Banner tone="error">{t("providerSignInUnavailable")}</Banner>
          )}
          {hardwareKeyRecovery && canAdminister && (
            <>
              <p>
                {row?.supportsInAppLogin && row.supportsHostTerminalLogin
                  ? t("providerSignInCodexHostHardwareKeyHint", {
                      terminalAction: t("providersSignInHostTerminal"),
                    })
                  : t("providerSignInCodexBrowserHardwareKeyHint")}
              </p>
              <a
                href="https://learn.chatgpt.com/docs/auth#fallback-forward-the-localhost-callback-over-ssh"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("providerSignInCodexRemoteBrowserHelp")}
              </a>
            </>
          )}
          <Link to={`${basePath}/settings/providers`}>
            {t("providerSignInSettings")}
          </Link>
        </section>
      </main>
    </MainContent>
  );
}
