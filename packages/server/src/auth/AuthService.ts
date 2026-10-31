/**
 * AuthService manages cookie-based authentication.
 *
 * Features:
 * - Single user account (self-hosted apps typically have one owner)
 * - Session-based auth with signed cookies
 * - Password hashing with bcrypt
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import bcrypt from "bcrypt";
import {
  OWNER_READ_WRITE_FILE_MODE,
  enforceOwnerReadWriteFilePermissions,
} from "../utils/filePermissions.js";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";

const BCRYPT_ROUNDS = 12;
const SESSION_ID_BYTES = 32;

export interface AuthState {
  /** Schema version for future migrations */
  version: number;
  /** Whether auth is enabled (can be enabled via settings UI) */
  enabled?: boolean;
  /** Whether unauthenticated localhost access is allowed (bypasses desktop token floor) */
  localhostOpen?: boolean;
  /** Account credentials (undefined = setup mode) */
  account?: {
    /** bcrypt-hashed password */
    passwordHash: string;
    /** When account was created */
    createdAt: string;
  };
  /** Active sessions: SHA-256 session verifier -> session data */
  sessions: Record<
    string,
    {
      createdAt: string;
      lastActiveAt: string;
      userAgent?: string;
      /**
       * Limited user this session authenticated as. Absent means the
       * superuser, which is every session created before limited users
       * existed (topics/limited-users.md).
       */
      username?: string;
    }
  >;
}

const CURRENT_VERSION = 2;

function sessionVerifier(sessionId: string): string {
  return crypto
    .createHash("sha256")
    .update("yep-anywhere-auth-session\0")
    .update(sessionId)
    .digest("hex");
}

export interface AuthServiceOptions {
  /** Directory to store auth state (defaults to dataDir) */
  dataDir: string;
  /** Session TTL in milliseconds (default: 30 days) */
  sessionTtlMs?: number;
  /** Cookie signing secret (auto-generated if not provided) */
  cookieSecret?: string;
}

export class AuthService {
  private state: AuthState;
  private dataDir: string;
  private filePath: string;
  private sessionTtlMs: number;
  private cookieSecret: string;
  private saver = createCoalescingSaver(() => this.doSave());
  private save = this.saver.save;

  constructor(options: AuthServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "auth.json");
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.cookieSecret = options.cookieSecret ?? "";
    this.state = { version: CURRENT_VERSION, sessions: {} };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory if it doesn't exist.
   * Generates cookie secret if not provided.
   */
  async initialize(): Promise<void> {
    let failureReason = "could not read the authentication file";
    let fileLoaded = false;
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await enforceOwnerReadWriteFilePermissions(
        this.filePath,
        "[AuthService]",
      );

      const content = await fs.readFile(this.filePath, "utf-8");
      fileLoaded = true;
      if (content.trim().length === 0) {
        failureReason = "the authentication file is empty";
        throw new Error(failureReason);
      }
      if (/^\0+$/.test(content)) {
        failureReason = "the authentication file contains only zero bytes";
        throw new Error(failureReason);
      }
      if (content.includes("\0")) {
        failureReason =
          "the authentication file contains unexpected zero bytes";
        throw new Error(failureReason);
      }
      failureReason =
        "the authentication file contains invalid or truncated JSON";
      const parsed = JSON.parse(content) as AuthState;
      failureReason =
        "the authentication file has an unsupported format or version";

      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else if (parsed.version === 1) {
        // Version 1 persisted raw bearer tokens as object keys. Preserve the
        // account and settings, but invalidate those exposed sessions.
        this.state = {
          version: CURRENT_VERSION,
          enabled: parsed.enabled,
          localhostOpen: parsed.localhostOpen,
          account: parsed.account,
          sessions: {},
        };
        failureReason = "could not persist the authentication file migration";
        await this.save();
      } else {
        throw new Error(failureReason);
      }
    } catch (error) {
      if (fileLoaded || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Fail closed. Starting "fresh" here once turned a truncated file into
        // a server with no password and no logins, so every browser holding
        // another credential became the owner, limited users included
        // (topics/security.md § Local Access). The file is left as it is.
        throw new Error(
          `[AuthService] ${this.filePath} is unreadable: ${failureReason}. ` +
            "Refusing to start with local authentication off. " +
            "Preserve a backup of this file before attempting recovery. " +
            "Restore a known-good backup, or move this file aside to deliberately reset local access. " +
            "Then restart the server. After a reset, reconfigure local authentication; " +
            "previous local logins will no longer work.",
        );
      }
      // No file at all: local access was never configured.
      this.state = { version: CURRENT_VERSION, sessions: {} };
    }

    // Generate cookie secret if not provided
    if (!this.cookieSecret) {
      this.cookieSecret = crypto.randomBytes(32).toString("hex");
    }

    // Clean up expired sessions on startup
    await this.cleanupExpiredSessions();
  }

  /**
   * Check if auth is enabled (via settings).
   */
  isEnabled(): boolean {
    return this.state.enabled === true;
  }

  /**
   * Check if unauthenticated localhost access is allowed (bypasses desktop token floor).
   */
  isLocalhostOpen(): boolean {
    return this.state.localhostOpen === true;
  }

  /**
   * Set whether unauthenticated localhost access is allowed.
   */
  async setLocalhostOpen(open: boolean): Promise<void> {
    this.state.localhostOpen = open || undefined; // Don't persist false
    await this.save();
  }

  /**
   * Check if an account has been set up.
   */
  hasAccount(): boolean {
    return !!this.state.account;
  }

  /**
   * Get the path to the auth state file (for recovery instructions).
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Enable auth with a password. Creates account if needed.
   * This is the main way to enable auth from the settings UI.
   *
   * Security model note:
   * - This project is localhost-first and starts with auth off.
   * - Enabling auth while currently open is treated as adding protection,
   *   not as recovering an ownership-locked account.
   * - If someone enables auth unexpectedly, the operator can restart with
   *   --auth-disable or run --setup-auth to recover.
   */
  async enableAuth(password: string): Promise<boolean> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    this.state.enabled = true;
    this.state.account = {
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    await this.save();
    return true;
  }

  /**
   * Disable auth and clear credentials.
   *
   * This is intentionally destructive: when auth is turned off, the server
   * returns to the default localhost/no-auth baseline. Re-enabling auth later
   * should behave like fresh setup with a new password.
   */
  async disableAuth(): Promise<void> {
    this.state.enabled = false;
    this.state.account = undefined;
    this.state.sessions = {}; // Clear all sessions
    await this.save();
  }

  /**
   * Create the initial account. Only works if no account exists.
   * @deprecated Use enableAuth instead which also sets the enabled flag.
   */
  async createAccount(password: string): Promise<boolean> {
    if (this.state.account) {
      return false; // Account already exists
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    this.state.account = {
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    await this.save();
    return true;
  }

  /**
   * Verify a password against the stored hash.
   */
  async verifyPassword(password: string): Promise<boolean> {
    if (!this.state.account) {
      return false;
    }
    return bcrypt.compare(password, this.state.account.passwordHash);
  }

  /**
   * Change the account password.
   * Requires an authenticated session (checked in route).
   */
  async changePassword(newPassword: string): Promise<boolean> {
    if (!this.state.account) {
      return false;
    }

    this.state.account.passwordHash = await bcrypt.hash(
      newPassword,
      BCRYPT_ROUNDS,
    );
    await this.save();
    return true;
  }

  /**
   * Create a new session and return the session ID.
   */
  async createSession(userAgent?: string, username?: string): Promise<string> {
    const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString("hex");
    const now = new Date().toISOString();

    this.state.sessions[sessionVerifier(sessionId)] = {
      createdAt: now,
      lastActiveAt: now,
      userAgent,
      ...(username ? { username } : {}),
    };
    await this.save();

    return sessionId;
  }

  /** Read-only live admission check for queued owner-authorized operations. */
  isSessionActive(sessionId: string): boolean {
    const session = this.state.sessions[sessionVerifier(sessionId)];
    return Boolean(
      session &&
        Date.now() - new Date(session.createdAt).getTime() <= this.sessionTtlMs,
    );
  }

  /**
   * Validate a session ID.
   * Returns true if valid, false if expired or not found.
   *
   * A valid check writes nothing. It used to stamp `lastActiveAt` and save
   * auth.json on every authenticated request, though nothing reads that field
   * (expiry follows `createdAt`), which kept the credential file under
   * constant rewrite; a restart during one of those saves once emptied it.
   * auth.json now changes only when a credential or login does.
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const verifier = sessionVerifier(sessionId);
    const session = this.state.sessions[verifier];
    if (!session) {
      return false;
    }

    const createdAt = new Date(session.createdAt).getTime();
    const now = Date.now();

    if (now - createdAt > this.sessionTtlMs) {
      // Session expired
      delete this.state.sessions[verifier];
      await this.save();
      return false;
    }

    return true;
  }

  /**
   * The limited user a valid session authenticated as, or null for the
   * superuser (and for an unknown or expired session).
   */
  getSessionUsername(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    const session = this.state.sessions[sessionVerifier(sessionId)];
    if (!session) return null;
    const createdAt = new Date(session.createdAt).getTime();
    if (Date.now() - createdAt > this.sessionTtlMs) return null;
    return session.username ?? null;
  }

  /**
   * Invalidate a session (logout).
   */
  async invalidateSession(sessionId: string): Promise<void> {
    const verifier = sessionVerifier(sessionId);
    if (this.state.sessions[verifier]) {
      delete this.state.sessions[verifier];
      await this.save();
    }
  }

  /**
   * Invalidate every session a limited user logged in with, e.g. when their
   * password is replaced. Returns how many were invalidated.
   */
  async invalidateUserSessions(username: string): Promise<number> {
    let count = 0;
    for (const [verifier, session] of Object.entries(this.state.sessions)) {
      if (session.username === username) {
        delete this.state.sessions[verifier];
        count += 1;
      }
    }
    if (count > 0) await this.save();
    return count;
  }

  /**
   * Invalidate all sessions (logout everywhere).
   */
  async invalidateAllSessions(): Promise<void> {
    this.state.sessions = {};
    await this.save();
  }

  /**
   * Get the cookie secret for signing.
   */
  getCookieSecret(): string {
    return this.cookieSecret;
  }

  /** Wait until the latest in-memory authentication state is durable. */
  async flushPendingWrites(): Promise<void> {
    await this.saver.flush();
  }

  /** Wait for saves already queued; unlike a flush, never starts a write. */
  async waitForPendingWrites(): Promise<void> {
    await this.saver.idle();
  }

  /**
   * Clean up expired sessions.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    let changed = false;

    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      const createdAt = new Date(session.createdAt).getTime();
      if (now - createdAt > this.sessionTtlMs) {
        delete this.state.sessions[sessionId];
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      // Sync before replacement: an interrupted in-place save once damaged
      // this file, and atomic replacement alone does not flush staged data.
      await writeFileAtomically(this.filePath, content, {
        mode: OWNER_READ_WRITE_FILE_MODE,
        durable: true,
      });
      await enforceOwnerReadWriteFilePermissions(
        this.filePath,
        "[AuthService]",
      );
    } catch (error) {
      console.error("[AuthService] Failed to save state:", error);
      throw error;
    }
  }
}
