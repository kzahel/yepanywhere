import { mutateResumeCredentials } from "../lib/rejectedResumeStorage";
/**
 * RelayLoginPage - Login form for remote access via relay server.
 *
 * Connects to a relay server first, which pairs the client with a yepanywhere
 * server by username. After pairing, SRP authentication proceeds through the relay.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Banner } from "../components/ui/Banner";
import { Button, ButtonBase } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { Field, TextInput } from "../components/ui/Field";
import { Spinner } from "../components/ui/Spinner";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useSignInRequiredNotice } from "../hooks/useSignInRequiredNotice";
import { useI18n } from "../i18n";
import {
  getDefaultRelayUrl,
  resolveLoginRelayUrl,
} from "../lib/defaultRelayUrl";
import { getHostByRelayUsername, upsertRelayHost } from "../lib/hostStorage";

/**
 * Parse credentials from URL hash for auto-login via QR code.
 * Hash format: #u=username&p=password&r=relay_url (r is optional)
 * Clears the hash after reading for security.
 */
function parseHashCredentials(): {
  username: string;
  password: string;
  relayUrl: string;
} | null {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;

  try {
    const params = new URLSearchParams(hash.slice(1));
    const username = params.get("u");
    const password = params.get("p");
    const relayUrl = params.get("r") ?? "";

    if (username && password) {
      // Clear hash from URL for security (don't leave password in history)
      window.history.replaceState(null, "", window.location.pathname);
      return { username, password, relayUrl };
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

type ConnectionStatus =
  | "idle"
  | "connecting_relay"
  | "waiting_server"
  | "authenticating"
  | "error";

export function RelayLoginPage() {
  const { t } = useI18n();
  const { connectViaRelay, isAutoResuming, setCurrentHostId } =
    useRemoteConnection();
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultRelayUrl = getDefaultRelayUrl();

  // Form state. The relay username names the *server* to route to; the SRP
  // identity names *who is logging in*. They are the same for the superuser,
  // which is why one field served until limited users existed — a limited
  // user connects to somebody else's server name under their own name.
  // topics/limited-users.md § Delivery v1 — Login, switching, and logout.
  // Pre-fill from query parameters: ?u=username&r=relay-url&as=limited-user
  const initialRelayUrl = searchParams.get("r") ?? "";
  const [relayUsername, setRelayUsername] = useState(
    () => searchParams.get("u") ?? "",
  );
  const [limitedUsername, setLimitedUsername] = useState(
    () => searchParams.get("as") ?? "",
  );
  const [srpPassword, setSrpPassword] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(
    !!initialRelayUrl || !!searchParams.get("as"),
  );
  const [customRelayUrl, setCustomRelayUrl] = useState(initialRelayUrl);
  const [rememberMe, setRememberMe] = useState(true);

  // Connection state
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const signInNotice = useSignInRequiredNotice();
  const [error, setError] = useState<string | null>(signInNotice);

  // Host of the relay a submit would use right now, so the choice is visible
  // without expanding the advanced options.
  const previewRelayHost = useMemo(() => {
    try {
      const url = resolveLoginRelayUrl(
        customRelayUrl,
        getHostByRelayUsername(relayUsername.trim().toLowerCase())?.relayUrl,
      );
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }, [customRelayUrl, relayUsername]);

  // Auto-login from hash credentials (QR code scan)
  const autoLoginAttempted = useRef(false);
  useEffect(() => {
    if (autoLoginAttempted.current || isAutoResuming) return;
    autoLoginAttempted.current = true;

    const hashCreds = parseHashCredentials();
    if (!hashCreds) return;

    const { username, password, relayUrl } = hashCreds;
    let effectiveRelayUrl: string;
    try {
      effectiveRelayUrl = resolveLoginRelayUrl(
        relayUrl,
        getHostByRelayUsername(username)?.relayUrl,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      setRelayUsername(username);
      if (relayUrl) {
        setCustomRelayUrl(relayUrl);
        setShowAdvanced(true);
      }
      return;
    }

    // Save the current relay URL before connecting so session callbacks and
    // later relay routes do not reuse a stale relay endpoint.
    setStatus("connecting_relay");
    mutateResumeCredentials(() => {
      const host = upsertRelayHost({
        relayUrl: effectiveRelayUrl,
        relayUsername: username,
        srpUsername: username,
      });
      // Set currentHostId before connect so the session callback can use it
      setCurrentHostId(host.id);
    })
      .then(() =>
        connectViaRelay({
          relayUrl: effectiveRelayUrl,
          relayUsername: username,
          srpUsername: username,
          srpPassword: password,
          rememberMe: true,
          onStatusChange: setStatus,
        }),
      )
      .then(() => {
        // Host already saved and currentHostId already set
      })
      .catch((err) => {
        const message =
          err instanceof Error
            ? err.message
            : t("relayLoginErrorConnectionFailed");
        setError(formatRelayError(message, effectiveRelayUrl, t));
        setStatus("error");
        // Pre-fill form with credentials from hash so user can retry
        setRelayUsername(username);
        if (relayUrl) {
          setCustomRelayUrl(relayUrl);
          setShowAdvanced(true);
        }
      });
  }, [connectViaRelay, isAutoResuming, setCurrentHostId, t]);

  // If auto-resume is in progress, show a loading screen
  if (isAutoResuming) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-logo">
            <YepAnywhereLogo />
          </div>
          <p className="login-subtitle">{t("reconnecting")}</p>
          <div className="login-loading" data-testid="auto-resume-loading">
            <Spinner size="large" />
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Read the fields themselves: a password manager's fill can reach the
    // inputs before this component sees it as an edit.
    const form = new FormData(e.currentTarget as HTMLFormElement);
    const identityValue = String(form.get("limited-user") ?? limitedUsername);
    const passwordValue = String(form.get("password") ?? srpPassword);
    const identity = identityValue.trim().toLowerCase();
    const serverNameValue = String(
      form.get("username") ?? relayUsername,
    ).trim();
    if (serverNameValue !== relayUsername) setRelayUsername(serverNameValue);
    if (identityValue !== limitedUsername) setLimitedUsername(identityValue);
    if (passwordValue !== srpPassword) setSrpPassword(passwordValue);

    // Validate inputs
    if (!serverNameValue) {
      setError(t("relayLoginErrorServerNameRequired"));
      return;
    }

    if (!passwordValue) {
      setError(t("relayLoginErrorPasswordRequired"));
      return;
    }

    const username = serverNameValue.toLowerCase();
    let relayUrl: string;
    try {
      relayUrl = resolveLoginRelayUrl(
        customRelayUrl,
        getHostByRelayUsername(username)?.relayUrl,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Save the current relay URL before connecting so session callbacks and
    // later relay routes do not reuse a stale relay endpoint.
    // Blank means "this server's owner", which is the identity the server
    // name already implies.
    const srpUsername = identity || username;

    // The prefilled `u`/`r` name the sign-in target the login routes redirect
    // into once connected (matchesRelayLoginTarget). The submitted form is the
    // target now, so an edited server name or relay must replace them, or the
    // connected session never leaves this page.
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("u", username);
        if (next.has("r")) next.set("r", relayUrl);
        return next;
      },
      { replace: true },
    );

    if (rememberMe) {
      const host = await mutateResumeCredentials(() =>
        upsertRelayHost({
          relayUrl,
          relayUsername: username,
          srpUsername,
        }),
      );
      // Set currentHostId before connect so the session callback can use it
      setCurrentHostId(host.id);
    }

    try {
      await connectViaRelay({
        relayUrl,
        relayUsername: username,
        srpUsername,
        srpPassword: passwordValue,
        rememberMe,
        onStatusChange: setStatus,
      });
      // On success, the RemoteApp will render the main app instead of login
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t("relayLoginErrorConnectionFailed");
      setError(formatRelayError(message, relayUrl, t));
      setStatus("error");
    }
  };

  const isConnecting = status !== "idle" && status !== "error";
  const statusMessage = getStatusMessage(status, t);

  return (
    <div className="login-page">
      <div className="login-container">
        <Link to="/login" className="login-back-link">
          &larr; {t("actionBack")}
        </Link>

        <div className="login-logo">
          <YepAnywhereLogo />
        </div>
        <p className="login-subtitle">{t("relayLoginTitle")}</p>

        <form
          onSubmit={handleSubmit}
          className="login-form"
          data-testid="relay-login-form"
        >
          {/* Keep the computer name as the saved login's username, including
              when Advanced exposes the optional limited-user override. */}
          <Field
            id="relayUsername"
            label={t("relayLoginServerName")}
            hint={t("relayLoginServerNameHint")}
          >
            <TextInput
              name="username"
              type="text"
              value={relayUsername}
              onChange={(e) => setRelayUsername(e.target.value)}
              placeholder={t("relayLoginUsernamePlaceholder")}
              disabled={isConnecting}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="relay-username-input"
            />
          </Field>

          <Field id="srpPassword" label={t("relayLoginPassword")}>
            <TextInput
              name="password"
              type="password"
              value={srpPassword}
              onChange={(e) => setSrpPassword(e.target.value)}
              placeholder={t("relayLoginPasswordPlaceholder")}
              disabled={isConnecting}
              autoComplete="current-password"
              data-testid="srp-password-input"
            />
          </Field>

          <Checkbox
            label={t("relayLoginRememberMe")}
            checked={rememberMe}
            onCheckedChange={setRememberMe}
            disabled={isConnecting}
            data-testid="remember-me-checkbox"
          />

          <ButtonBase
            className="login-advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
            disabled={isConnecting}
          >
            {showAdvanced
              ? t("relayLoginHideAdvanced")
              : t("relayLoginShowAdvanced")}
          </ButtonBase>

          {showAdvanced && (
            <Field
              id="limitedUsername"
              label={t("relayLoginLimitedUsername")}
              hint={t("relayLoginLimitedUsernameHint")}
            >
              <TextInput
                name="limited-user"
                type="text"
                value={limitedUsername}
                onChange={(e) => setLimitedUsername(e.target.value)}
                placeholder={t("relayLoginLimitedUsernamePlaceholder")}
                disabled={isConnecting}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                data-testid="relay-limited-username-input"
              />
            </Field>
          )}

          {showAdvanced && (
            <Field
              id="customRelayUrl"
              label={t("relayLoginCustomRelayUrl")}
              hint={t("relayLoginCustomRelayUrlHint")}
            >
              <TextInput
                type="text"
                value={customRelayUrl}
                onChange={(e) => setCustomRelayUrl(e.target.value)}
                placeholder={defaultRelayUrl}
                disabled={isConnecting}
                data-testid="custom-relay-url-input"
              />
            </Field>
          )}

          {previewRelayHost && (
            <p className="login-relay-preview" data-testid="relay-host-preview">
              {t("relayLoginRelayHostPreview", { host: previewRelayHost })}
            </p>
          )}

          {error && (
            <Banner tone="error" data-testid="login-error">
              {error}
            </Banner>
          )}

          {isConnecting && statusMessage && (
            <div className="login-status" data-testid="connection-status">
              <Spinner />
              <span>{statusMessage}</span>
            </div>
          )}

          <Button
            variant="primary"
            type="submit"
            disabled={isConnecting}
            data-testid="login-button"
          >
            {isConnecting ? t("relayLoginConnecting") : t("relayLoginConnect")}
          </Button>
        </form>

        <p className="login-hint">{t("relayLoginHint")}</p>
      </div>
    </div>
  );
}

function getStatusMessage(
  status: ConnectionStatus,
  t: (key: never) => string,
): string | null {
  switch (status) {
    case "connecting_relay":
      return t("relayLoginStatusConnectingRelay" as never);
    case "waiting_server":
      return t("relayLoginStatusWaitingServer" as never);
    case "authenticating":
      return t("relayLoginStatusAuthenticating" as never);
    default:
      return null;
  }
}

function formatRelayError(
  message: string,
  relayUrl: string,
  t: (key: never, values?: Record<string, string>) => string,
): string {
  if (message.includes("server_offline")) {
    return t("relayLoginErrorServerOfflineWithRelay" as never, { relayUrl });
  }
  if (message.includes("unknown_username")) {
    return t("relayLoginErrorUnknownUsername" as never);
  }
  if (
    message.includes("Authentication failed") ||
    message.includes("invalid_identity")
  ) {
    return t("relayLoginErrorInvalidCredentials" as never);
  }
  return message;
}
