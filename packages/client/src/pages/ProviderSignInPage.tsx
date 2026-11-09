import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { Banner } from "../components/ui/Banner";
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
  const { row, loading, error, refresh, sourceKey } = useProviderRow(provider);
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
          ) : row?.authenticated ? (
            <Banner tone="success">
              {t("providerSignInReady", { provider: name })}
            </Banner>
          ) : row?.supportsInAppLogin ? (
            <ProviderSignIn
              key={`${sourceKey}:${provider}`}
              provider={provider}
              displayName={name}
              supportsHostTerminal={row.supportsHostTerminalLogin === true}
              onSignedIn={() => void refresh()}
            />
          ) : (
            <Banner tone="error">{t("providerSignInUnavailable")}</Banner>
          )}
          <Link to={`${basePath}/settings/providers`}>
            {t("providerSignInSettings")}
          </Link>
        </section>
      </main>
    </MainContent>
  );
}
