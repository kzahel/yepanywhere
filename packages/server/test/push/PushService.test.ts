import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushService } from "../../src/push/PushService.js";
import type { PushSubscription, VapidKeys } from "../../src/push/index.js";
import { generateVapidKeys } from "../../src/push/vapid.js";

// Mock web-push to avoid actual network calls
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
    generateVAPIDKeys: vi.fn(() => ({
      publicKey:
        "BNvS3m-n6IpLpGlxj3Mbl7VnBMwGG8syHB9Z45fELFKrQDGwB7z1Gs6ZF7JpY_gRqZDPqZpXnUzSyZvdOWOTnw8",
      privateKey: "qXsHkzrVZy7ks6q6BZf4mTl4F4oKHH9dXtWlPzMknJs",
    })),
  },
}));

import webPush from "web-push";

describe("PushService", () => {
  let tempDir: string;
  let pushService: PushService;
  let vapidKeys: VapidKeys;

  const mockSubscription: PushSubscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
    keys: {
      p256dh:
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-test-"));

    // Generate real VAPID keys for testing
    vapidKeys = await generateVapidKeys(path.join(tempDir, "vapid.json"));

    pushService = new PushService({
      dataDir: tempDir,
      vapidKeys,
    });

    await pushService.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("should initialize with empty subscriptions", () => {
      expect(pushService.getSubscriptionCount()).toBe(0);
    });

    it("should load existing subscriptions from disk", async () => {
      // Create a service and add a subscription
      await pushService.subscribe("profile-1", mockSubscription);
      expect(pushService.getSubscriptionCount()).toBe(1);

      // Create new service pointing to same directory
      const newService = new PushService({
        dataDir: tempDir,
        vapidKeys,
      });
      await newService.initialize();

      expect(newService.getSubscriptionCount()).toBe(1);
      expect(newService.isSubscribed("profile-1")).toBe(true);
    });

    it("should handle corrupted subscription file gracefully", async () => {
      const filePath = path.join(tempDir, "push-subscriptions.json");
      await fs.writeFile(filePath, "not valid json");
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const newService = new PushService({ dataDir: tempDir });
      await newService.initialize();

      expect(newService.getSubscriptionCount()).toBe(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        "[PushService] Failed to load subscriptions, starting fresh:",
        expect.any(SyntaxError),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("subscription management", () => {
    it("should subscribe a device", async () => {
      await pushService.subscribe("profile-1", mockSubscription);

      expect(pushService.isSubscribed("profile-1")).toBe(true);
      expect(pushService.getSubscriptionCount()).toBe(1);
    });

    it("should store subscription metadata", async () => {
      await pushService.subscribe("profile-1", mockSubscription, {
        userAgent: "Mozilla/5.0 Test Browser",
        deviceName: "My Phone",
      });

      const stored = pushService.getSubscriptions()["profile-1"];
      assert(stored, "Expected persisted subscription metadata");
      expect(stored.userAgent).toBe("Mozilla/5.0 Test Browser");
      expect(stored.deviceName).toBe("My Phone");
      expect(stored.createdAt).toBeDefined();
    });

    it("should update existing subscription", async () => {
      await pushService.subscribe("profile-1", mockSubscription, {
        deviceName: "Old Name",
      });

      const newSubscription = {
        ...mockSubscription,
        endpoint: "https://new-endpoint.com",
      };

      await pushService.subscribe("profile-1", newSubscription, {
        deviceName: "New Name",
      });

      const stored = pushService.getSubscriptions()["profile-1"];
      assert(stored, "Expected updated subscription");
      expect(stored.subscription.endpoint).toBe("https://new-endpoint.com");
      expect(stored.deviceName).toBe("New Name");
    });

    it("should unsubscribe a device", async () => {
      await pushService.subscribe("profile-1", mockSubscription);
      expect(pushService.isSubscribed("profile-1")).toBe(true);

      const removed = await pushService.unsubscribe("profile-1");
      expect(removed).toBe(true);
      expect(pushService.isSubscribed("profile-1")).toBe(false);
    });

    it("should return false when unsubscribing non-existent device", async () => {
      const removed = await pushService.unsubscribe("non-existent");
      expect(removed).toBe(false);
    });

    it("should persist subscriptions to disk", async () => {
      await pushService.subscribe("profile-1", mockSubscription);

      const filePath = path.join(tempDir, "push-subscriptions.json");
      const content = await fs.readFile(filePath, "utf-8");
      const saved = JSON.parse(content);

      expect(saved.subscriptions["profile-1"]).toBeDefined();
      expect(saved.subscriptions["profile-1"].subscription.endpoint).toBe(
        mockSubscription.endpoint,
      );
    });
  });

  describe("notification settings", () => {
    it("defaults session halted notifications off", () => {
      expect(pushService.getNotificationSettings()).toEqual({
        toolApproval: true,
        userQuestion: true,
        sessionHalted: false,
        projectInactive: false,
        yaInactive: false,
      });
      expect(pushService.isNotificationTypeEnabled("sessionHalted")).toBe(
        false,
      );
    });

    it("preserves explicit session halted settings", async () => {
      await pushService.setNotificationSettings({ sessionHalted: true });

      const newService = new PushService({
        dataDir: tempDir,
        vapidKeys,
      });
      await newService.initialize();

      expect(newService.isNotificationTypeEnabled("sessionHalted")).toBe(true);
    });

    it("merges new default settings into older persisted settings", async () => {
      await fs.writeFile(
        path.join(tempDir, "push-subscriptions.json"),
        JSON.stringify(
          {
            version: 1,
            subscriptions: {},
            settings: {
              toolApproval: false,
              userQuestion: true,
              sessionHalted: false,
            },
          },
          null,
          2,
        ),
      );

      const newService = new PushService({
        dataDir: tempDir,
        vapidKeys,
      });
      await newService.initialize();

      expect(newService.getNotificationSettings()).toEqual({
        toolApproval: false,
        userQuestion: true,
        sessionHalted: false,
        projectInactive: false,
        yaInactive: false,
      });
    });

    it("persists explicit inactivity settings", async () => {
      await pushService.setNotificationSettings({
        projectInactive: true,
        yaInactive: true,
      });

      const newService = new PushService({
        dataDir: tempDir,
        vapidKeys,
      });
      await newService.initialize();

      expect(newService.isNotificationTypeEnabled("projectInactive")).toBe(
        true,
      );
      expect(newService.isNotificationTypeEnabled("yaInactive")).toBe(true);
    });
  });

  describe("VAPID keys", () => {
    it("should return public key when configured", () => {
      expect(pushService.getPublicKey()).toBe(vapidKeys.publicKey);
    });

    it("should return null when VAPID keys not configured", async () => {
      const noKeysService = new PushService({ dataDir: tempDir });
      await noKeysService.initialize();

      expect(noKeysService.getPublicKey()).toBeNull();
    });

    it("should configure web-push with VAPID keys", () => {
      expect(webPush.setVapidDetails).toHaveBeenCalledWith(
        vapidKeys.subject,
        vapidKeys.publicKey,
        vapidKeys.privateKey,
      );
    });
  });

  describe("sending notifications", () => {
    it("should send notification to device", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);

      const result = await pushService.sendToBrowserProfile("profile-1", {
        type: "test",
        message: "Hello",
        timestamp: new Date().toISOString(),
      });

      expect(result.success).toBe(true);
      expect(result.browserProfileId).toBe("profile-1");
      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining('"type":"test"'),
        { urgency: "high" },
      );
    });

    it("should request high urgency delivery for pending input", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);

      await pushService.sendToBrowserProfile("profile-1", {
        type: "pending-input",
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "Project",
        inputType: "tool-approval",
        summary: "Edit: index.ts",
        timestamp: new Date().toISOString(),
      });

      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining('"type":"pending-input"'),
        { urgency: "high" },
      );
    });

    it("should request high urgency delivery for session halted notifications", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);

      await pushService.sendToBrowserProfile("profile-1", {
        type: "session-halted",
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "Project",
        reason: "completed",
        duration: 10_000,
        timestamp: new Date().toISOString(),
      });

      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining('"type":"session-halted"'),
        { urgency: "high" },
      );
    });

    it("should request high urgency delivery for inactivity notifications", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);

      await pushService.sendToBrowserProfile("profile-1", {
        type: "project-inactive",
        projectId: "project-1",
        projectName: "Project",
        timestamp: new Date().toISOString(),
      });

      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining('"type":"project-inactive"'),
        { urgency: "high" },
      );

      await pushService.sendToBrowserProfile("profile-1", {
        type: "ya-inactive",
        projectCount: 1,
        timestamp: new Date().toISOString(),
      });

      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining('"type":"ya-inactive"'),
        { urgency: "high" },
      );
    });

    it("should honor explicit test delivery urgency", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);
      await pushService.sendTest(
        "profile-1",
        "Normal priority test",
        "normal",
        "normal",
      );

      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining("Normal priority test"),
        { urgency: "normal" },
      );
    });

    it("should not request high urgency delivery for dismiss messages", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);

      await pushService.sendToBrowserProfile("profile-1", {
        type: "dismiss",
        sessionId: "session-1",
        timestamp: new Date().toISOString(),
      });

      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining('"type":"dismiss"'),
        undefined,
      );
    });

    it("should return error for non-existent device", async () => {
      const result = await pushService.sendToBrowserProfile("non-existent", {
        type: "test",
        message: "Hello",
        timestamp: new Date().toISOString(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not subscribed");
    });

    it("should send to all devices", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);
      await pushService.subscribe("profile-2", {
        ...mockSubscription,
        endpoint: "https://other-endpoint.com",
      });

      const results = await pushService.sendToAll({
        type: "test",
        message: "Broadcast",
        timestamp: new Date().toISOString(),
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it("should clean up expired subscriptions on 410 response", async () => {
      const error = new Error("Gone") as Error & { statusCode: number };
      error.statusCode = 410;
      vi.mocked(webPush.sendNotification).mockRejectedValue(error);

      await pushService.subscribe("profile-1", mockSubscription);
      expect(pushService.isSubscribed("profile-1")).toBe(true);

      await pushService.sendToAll({
        type: "test",
        message: "Test",
        timestamp: new Date().toISOString(),
      });

      expect(pushService.isSubscribed("profile-1")).toBe(false);
    });

    it("should handle send errors gracefully", async () => {
      const error = new Error("Network error") as Error & {
        statusCode: number;
      };
      error.statusCode = 500;
      vi.mocked(webPush.sendNotification).mockRejectedValue(error);

      await pushService.subscribe("profile-1", mockSubscription);

      const result = await pushService.sendToBrowserProfile("profile-1", {
        type: "test",
        message: "Test",
        timestamp: new Date().toISOString(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
      expect(result.statusCode).toBe(500);
      // Should not remove subscription on 500 error
      expect(pushService.isSubscribed("profile-1")).toBe(true);
    });
  });

  describe("test notification", () => {
    it("should send test notification with default message", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);
      const result = await pushService.sendTest("profile-1");

      expect(result.success).toBe(true);
      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining('"type":"test"'),
        { urgency: "high" },
      );
    });

    it("should send test notification with custom message", async () => {
      vi.mocked(webPush.sendNotification).mockResolvedValue({
        statusCode: 201,
        body: "",
        headers: {},
      });

      await pushService.subscribe("profile-1", mockSubscription);
      await pushService.sendTest("profile-1", "Custom test message");

      expect(webPush.sendNotification).toHaveBeenCalledWith(
        mockSubscription,
        expect.stringContaining("Custom test message"),
        { urgency: "high" },
      );
    });
  });
});
