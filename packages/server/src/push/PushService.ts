/**
 * PushService - Manages push subscriptions and sends notifications
 *
 * Handles:
 * - Storing/loading push subscriptions per device
 * - Sending push notifications via web-push
 * - Automatic cleanup of expired/invalid subscriptions
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import webPush from "web-push";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type PushPayload,
  type PushSubscription,
  type SendResult,
  type StoredSubscription,
  type SubscriptionState,
} from "./types.js";
import type { VapidKeys } from "./vapid.js";

const CURRENT_VERSION = 1;

export interface PushServiceOptions {
  /** Directory to store subscription data (defaults to ~/.yep-anywhere) */
  dataDir?: string;
  /** VAPID keys for signing push requests */
  vapidKeys?: VapidKeys;
}

export class PushService {
  private state: SubscriptionState;
  private dataDir: string;
  private filePath: string;
  private vapidKeys?: VapidKeys;
  private initialized = false;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: PushServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "push-subscriptions.json");
    this.vapidKeys = options.vapidKeys;
    this.state = { version: CURRENT_VERSION, subscriptions: {} };
  }

  /**
   * Initialize the service by loading state from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as SubscriptionState;

      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          subscriptions: parsed.subscriptions ?? {},
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[PushService] Failed to load subscriptions, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, subscriptions: {} };
    }

    // Configure web-push if we have VAPID keys
    if (this.vapidKeys) {
      this.configureWebPush(this.vapidKeys);
    }

    this.initialized = true;
  }

  /**
   * Set VAPID keys (can be called after initialization).
   */
  setVapidKeys(keys: VapidKeys): void {
    this.vapidKeys = keys;
    this.configureWebPush(keys);
  }

  /**
   * Configure web-push with VAPID keys.
   */
  private configureWebPush(keys: VapidKeys): void {
    webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  }

  /**
   * Get the VAPID public key for client subscription.
   */
  getPublicKey(): string | null {
    return this.vapidKeys?.publicKey ?? null;
  }

  /**
   * Subscribe a browser profile for push notifications.
   */
  async subscribe(
    browserProfileId: string,
    subscription: PushSubscription,
    options: { userAgent?: string; deviceName?: string } = {},
  ): Promise<void> {
    this.ensureInitialized();

    this.state.subscriptions[browserProfileId] = {
      subscription,
      createdAt: new Date().toISOString(),
      userAgent: options.userAgent,
      deviceName: options.deviceName,
    };

    await this.save();
  }

  /**
   * Unsubscribe a browser profile.
   */
  async unsubscribe(browserProfileId: string): Promise<boolean> {
    this.ensureInitialized();

    if (!this.state.subscriptions[browserProfileId]) {
      return false;
    }

    delete this.state.subscriptions[browserProfileId];
    await this.save();
    return true;
  }

  /**
   * Get all subscriptions.
   */
  getSubscriptions(): Record<string, StoredSubscription> {
    this.ensureInitialized();
    return { ...this.state.subscriptions };
  }

  /**
   * Get subscription count.
   */
  getSubscriptionCount(): number {
    return Object.keys(this.state.subscriptions).length;
  }

  /**
   * Check if a browser profile is subscribed.
   */
  isSubscribed(browserProfileId: string): boolean {
    return !!this.state.subscriptions[browserProfileId];
  }

  /**
   * Get notification settings.
   */
  getNotificationSettings(): NotificationSettings {
    return this.state.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
  }

  /**
   * Update notification settings.
   */
  async setNotificationSettings(
    settings: Partial<NotificationSettings>,
  ): Promise<NotificationSettings> {
    this.ensureInitialized();

    const current = this.getNotificationSettings();
    const updated: NotificationSettings = {
      ...current,
      ...settings,
    };

    this.state.settings = updated;
    await this.save();

    return updated;
  }

  /**
   * Check if a specific notification type is enabled.
   */
  isNotificationTypeEnabled(
    type: "toolApproval" | "userQuestion" | "sessionHalted",
  ): boolean {
    const settings = this.getNotificationSettings();
    return settings[type];
  }

  /**
   * Send a push notification to all subscribed browser profiles.
   * @param payload - The notification payload
   * @param options - Optional settings
   * @param options.excludeBrowserProfileIds - Browser profile IDs to skip (e.g., already connected)
   */
  async sendToAll(
    payload: PushPayload,
    options?: { excludeBrowserProfileIds?: string[] },
  ): Promise<SendResult[]> {
    this.ensureInitialized();

    if (!this.vapidKeys) {
      throw new Error("VAPID keys not configured");
    }

    const excludeSet = new Set(options?.excludeBrowserProfileIds ?? []);
    const browserProfileIds = Object.keys(this.state.subscriptions).filter(
      (id) => !excludeSet.has(id),
    );

    if (browserProfileIds.length === 0) {
      return [];
    }

    const results = await Promise.all(
      browserProfileIds.map((browserProfileId) =>
        this.sendToBrowserProfile(browserProfileId, payload),
      ),
    );

    // Clean up invalid subscriptions
    await this.cleanupInvalidSubscriptions(results);

    return results;
  }

  /**
   * Send a push notification to a specific browser profile.
   */
  async sendToBrowserProfile(
    browserProfileId: string,
    payload: PushPayload,
  ): Promise<SendResult> {
    this.ensureInitialized();

    if (!this.vapidKeys) {
      return {
        browserProfileId,
        success: false,
        error: "VAPID keys not configured",
      };
    }

    const stored = this.state.subscriptions[browserProfileId];
    if (!stored) {
      return {
        browserProfileId,
        success: false,
        error: "Browser profile not subscribed",
      };
    }

    try {
      const response = await webPush.sendNotification(
        stored.subscription,
        JSON.stringify(payload),
      );

      return {
        browserProfileId,
        success: true,
        statusCode: response.statusCode,
      };
    } catch (error) {
      const webPushError = error as webPush.WebPushError;
      return {
        browserProfileId,
        success: false,
        error: webPushError.message,
        statusCode: webPushError.statusCode,
      };
    }
  }

  /**
   * Send a test notification to verify setup.
   */
  async sendTest(
    browserProfileId: string,
    message = "Test notification",
    urgency?: "normal" | "persistent" | "silent",
  ): Promise<SendResult> {
    return this.sendToBrowserProfile(browserProfileId, {
      type: "test",
      message,
      urgency,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Clean up subscriptions that returned 404/410 (expired/unsubscribed).
   */
  private async cleanupInvalidSubscriptions(
    results: SendResult[],
  ): Promise<void> {
    const invalidProfiles = results.filter(
      (r) => !r.success && (r.statusCode === 404 || r.statusCode === 410),
    );

    if (invalidProfiles.length === 0) return;

    for (const { browserProfileId } of invalidProfiles) {
      delete this.state.subscriptions[browserProfileId];
      console.log(
        `[PushService] Removed expired subscription: ${browserProfileId}`,
      );
    }

    await this.save();
  }

  /**
   * Ensure service is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("PushService not initialized. Call initialize() first.");
    }
  }

  /**
   * Save state to disk with debouncing.
   */
  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[PushService] Failed to save subscriptions:", error);
      throw error;
    }
  }

  /**
   * Get file path (for testing).
   */
  getFilePath(): string {
    return this.filePath;
  }
}
