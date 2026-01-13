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

      const newService = new PushService({ dataDir: tempDir });
      await newService.initialize();

      expect(newService.getSubscriptionCount()).toBe(0);
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

      const subs = pushService.getSubscriptions();
      expect(subs["profile-1"]).toBeDefined();
      expect(subs["profile-1"].userAgent).toBe("Mozilla/5.0 Test Browser");
      expect(subs["profile-1"].deviceName).toBe("My Phone");
      expect(subs["profile-1"].createdAt).toBeDefined();
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

      const subs = pushService.getSubscriptions();
      expect(subs["profile-1"].subscription.endpoint).toBe(
        "https://new-endpoint.com",
      );
      expect(subs["profile-1"].deviceName).toBe("New Name");
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
      );
    });
  });
});
