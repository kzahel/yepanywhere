import { randomBytes, randomUUID } from "node:crypto";
import {
  type Stats,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const MARKER_PREFIX = "aar_local_";
const MARKER_PATTERN = /^aar_local_[A-Za-z0-9_-]{32,128}$/;
/** The routed profile's settings, exactly as this module writes them. */
const ROUTED_SETTINGS = `${JSON.stringify({ auth: { type: "oauth-personal" } }, null, 2)}\n`;

function assertPrivatePosix(stats: Stats, label: string): void {
  if (process.platform === "win32") return;
  if (stats.mode & 0o077) {
    throw new Error(`${label} has overly permissive permissions`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

function parseValidatedMarker(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Antigravity routed profile token file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Antigravity routed profile token file is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const tokenObj =
    record.token &&
    typeof record.token === "object" &&
    !Array.isArray(record.token)
      ? (record.token as Record<string, unknown>)
      : undefined;
  if (
    ("refresh_token" in record && record.refresh_token !== undefined) ||
    (tokenObj &&
      "refresh_token" in tokenObj &&
      tokenObj.refresh_token !== undefined)
  ) {
    throw new Error(
      "Refusing to overwrite a real Google OAuth credential in Antigravity router profile",
    );
  }
  if (
    record.auth_method !== "consumer" ||
    !tokenObj ||
    typeof tokenObj.access_token !== "string" ||
    !MARKER_PATTERN.test(tokenObj.access_token)
  ) {
    throw new Error(
      "Refusing to reuse an unexpected credential in Antigravity router profile",
    );
  }
  return tokenObj.access_token;
}

function validateBridgeSettings(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Antigravity router profile settings.json is invalid JSON");
  }
  const config = parsed as {
    auth?: { type?: unknown };
    modelProvider?: unknown;
  };
  if (config?.auth?.type !== "oauth-personal" || config.modelProvider) {
    throw new Error("Choose a dedicated Antigravity router profile");
  }
}

function ensurePrivateDirectory(dir: string, label: string): void {
  if (existsSync(dir)) {
    const stats = lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} must be a regular directory`);
    }
    assertPrivatePosix(stats, label);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
  }
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
  assertPrivatePosix(stats, label);
}

function writeFileIfAbsentAtomically(
  dir: string,
  targetPath: string,
  content: string,
): boolean {
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tempPath, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tempPath, targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      /* Already removed. */
    }
  }
}

/**
 * Prepare the private profile directory routed `agy acp` sessions share.
 * `agy` presents the login in its profile and also sends it to Google, so the
 * profile holds a local stand-in (`aar_local_*`) in `agy`'s token-file format
 * and never the AAR binding token. A directory holding a real Google login is
 * refused. Concurrent routed sessions share this stand-in; each runs its own
 * loopback proxy, which holds that session's binding token.
 */
export function prepareAntigravityRoutedProfile(home: string): {
  profileDir: string;
  marker: string;
} {
  const profileDir = resolve(home);
  const cliDir = join(profileDir, "antigravity-cli");
  ensurePrivateDirectory(profileDir, "Antigravity router profile directory");
  ensurePrivateDirectory(cliDir, "Antigravity router CLI profile directory");

  const settingsPath = join(cliDir, "settings.json");
  const tokenPath = join(cliDir, "antigravity-oauth-token");
  // A dangling symlink is present too, and is refused below.
  const present = (path: string) =>
    lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  const readMarker = () => {
    const stats = lstatSync(tokenPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Antigravity router profile token file is invalid");
    }
    assertPrivatePosix(stats, "Antigravity router profile token file");
    return parseValidatedMarker(readFileSync(tokenPath, "utf8"));
  };
  const readSettings = () => {
    const stats = lstatSync(settingsPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Antigravity router profile settings.json is invalid");
    }
    assertPrivatePosix(stats, "Antigravity router profile settings.json");
    const raw = readFileSync(settingsPath, "utf8");
    validateBridgeSettings(raw);
    return raw;
  };

  // Everything already in the profile is checked before anything is written.
  let marker = present(tokenPath) ? readMarker() : undefined;
  // A concurrent session may write the settings first; they are read back.
  const settings =
    present(settingsPath) ||
    !writeFileIfAbsentAtomically(cliDir, settingsPath, ROUTED_SETTINGS)
      ? readSettings()
      : ROUTED_SETTINGS;
  // `agy` deletes the token file when it takes its login from the operating
  // system's credential store, as 1.5.16 and 1.5.17 did on macOS. Only a
  // profile whose settings are still exactly what this module wrote gets a
  // new stand-in; `auth.type` alone is an ordinary `agy` setting.
  if (!marker && settings !== ROUTED_SETTINGS) {
    throw new Error(
      "Refusing to adopt an existing Antigravity profile without a router marker",
    );
  }

  if (!marker) {
    const generated = `${MARKER_PREFIX}${randomBytes(32).toString("base64url")}`;
    const payload = `${JSON.stringify({
      auth_method: "consumer",
      token: {
        access_token: generated,
        token_type: "Bearer",
        expiry: "9999-12-31T23:59:59Z",
      },
    })}\n`;
    // A concurrent session may have written its own first; use that one.
    marker = writeFileIfAbsentAtomically(cliDir, tokenPath, payload)
      ? generated
      : readMarker();
  }

  return { profileDir, marker };
}
