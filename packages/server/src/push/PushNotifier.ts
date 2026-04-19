/**
 * PushNotifier - Sends push notifications for session lifecycle events.
 *
 * Listens to EventBus and sends push notifications for:
 * - waiting-input: tool approval or user question needed
 * - idle: session turn completed
 * - terminated: session crashed/stopped unexpectedly
 *
 * The service worker on the client handles focused-window suppression.
 */

import { basename } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { decodeProjectId } from "../projects/paths.js";
import type { ConnectedBrowsersService } from "../services/ConnectedBrowsersService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { InputRequest } from "../supervisor/types.js";
import type {
  BusEvent,
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
} from "../watcher/EventBus.js";
import type { PushService } from "./PushService.js";
import type {
  DismissPayload,
  PendingInputPayload,
  SessionHaltedPayload,
} from "./types.js";

export interface PushNotifierOptions {
  eventBus: EventBus;
  pushService: PushService;
  supervisor: Supervisor;
  /** Optional: skip push for connected browser profiles */
  connectedBrowsers?: ConnectedBrowsersService;
}

export class PushNotifier {
  private eventBus: EventBus;
  private pushService: PushService;
  private supervisor: Supervisor;
  private connectedBrowsers?: ConnectedBrowsersService;
  private unsubscribe: (() => void) | null = null;
  /** Track sessions we've sent notifications for (to know when to send dismiss) */
  private sessionsWithNotification = new Set<string>();
  /** Track when the current active turn started so completion push can show duration */
  private activeSessionStartedAt = new Map<string, string>();

  constructor(options: PushNotifierOptions) {
    this.eventBus = options.eventBus;
    this.pushService = options.pushService;
    this.supervisor = options.supervisor;
    this.connectedBrowsers = options.connectedBrowsers;

    // Subscribe to EventBus for process state changes
    this.unsubscribe = this.eventBus.subscribe((event: BusEvent) => {
      if (event.type === "process-state-changed") {
        void this.handleProcessStateChange(event);
        return;
      }
      if (event.type === "process-terminated") {
        void this.handleProcessTerminated(event);
      }
    });
  }

  /**
   * Handle process state change events.
   * Sends push notification when entering waiting-input state.
   * Sends dismiss when leaving waiting-input state (if we sent a notification).
   */
  private async handleProcessStateChange(
    event: ProcessStateEvent,
  ): Promise<void> {
    if (event.activity === "in-turn" || event.activity === "waiting-input") {
      this.markSessionActive(event.sessionId, event.timestamp);
    }

    // Send dismiss when leaving waiting-input (if we sent a notification for it)
    if (event.activity !== "waiting-input") {
      if (this.sessionsWithNotification.has(event.sessionId)) {
        await this.sendDismiss(event.sessionId);
        this.sessionsWithNotification.delete(event.sessionId);
      }
      if (event.activity === "idle") {
        await this.sendSessionCompleted(event);
      }
      return;
    }

    // Check if there are any subscriptions
    if (this.pushService.getSubscriptionCount() === 0) {
      return;
    }

    // Get the process to access the InputRequest details
    const process = this.supervisor.getProcessForSession(event.sessionId);
    if (!process || process.state.type !== "waiting-input") {
      return;
    }

    const request = process.state.request;
    const inputType =
      request.type === "tool-approval" ? "tool-approval" : "user-question";

    // Check if this notification type is enabled in settings
    const settingKey =
      inputType === "tool-approval" ? "toolApproval" : "userQuestion";
    if (!this.pushService.isNotificationTypeEnabled(settingKey)) {
      return;
    }

    const projectName = this.getProjectName(event.projectId);
    const summary = this.buildSummary(request);

    const payload: PendingInputPayload = {
      type: "pending-input",
      sessionId: event.sessionId,
      projectId: event.projectId,
      projectName,
      inputType,
      summary,
      requestId: request.id,
      timestamp: event.timestamp,
    };

    try {
      // Connected browsers still receive the push. The service worker decides
      // whether to surface it based on focus/current-session state.
      const connectedCount =
        this.connectedBrowsers?.getConnectedBrowserProfileIds().length ?? 0;
      if (connectedCount > 0) {
        console.log(
          `[PushNotifier] Sending pending-input push while ${connectedCount} browser profile(s) are connected`,
        );
      }

      const results = await this.pushService.sendToAll(payload);
      const successCount = results.filter((r) => r.success).length;
      if (successCount > 0) {
        console.log(
          `[PushNotifier] Sent pending-input notification to ${successCount}/${results.length} devices`,
        );
        // Track that we sent a notification for this session
        this.sessionsWithNotification.add(event.sessionId);
      }
    } catch (error) {
      console.error("[PushNotifier] Failed to send push notification:", error);
    }
  }

  /**
   * Handle unexpected process termination events.
   * Sends dismiss for any pending approval notification, then an error notification.
   */
  private async handleProcessTerminated(
    event: ProcessTerminatedEvent,
  ): Promise<void> {
    if (this.sessionsWithNotification.has(event.sessionId)) {
      await this.sendDismiss(event.sessionId);
      this.sessionsWithNotification.delete(event.sessionId);
    }

    await this.sendSessionHalted({
      sessionId: event.sessionId,
      projectId: event.projectId,
      timestamp: event.timestamp,
      reason: "error",
    });
  }

  /**
   * Send a dismiss notification to close notifications on all devices.
   */
  private async sendDismiss(sessionId: string): Promise<void> {
    if (this.pushService.getSubscriptionCount() === 0) {
      return;
    }

    const payload: DismissPayload = {
      type: "dismiss",
      sessionId,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.pushService.sendToAll(payload);
      console.log(`[PushNotifier] Sent dismiss for session ${sessionId}`);
    } catch (error) {
      console.error("[PushNotifier] Failed to send dismiss:", error);
    }
  }

  /**
   * Send completion notification when a live process transitions to idle.
   * Ignores the synthetic idle event emitted during unregister.
   */
  private async sendSessionCompleted(event: ProcessStateEvent): Promise<void> {
    const process = this.supervisor.getProcessForSession(event.sessionId);
    if (!process || process.state.type !== "idle") {
      return;
    }

    await this.sendSessionHalted({
      sessionId: event.sessionId,
      projectId: event.projectId,
      timestamp: event.timestamp,
      reason: "completed",
    });
  }

  /**
   * Send a session-halted notification when a run completes or errors out.
   */
  private async sendSessionHalted(input: {
    sessionId: string;
    projectId: UrlProjectId;
    timestamp: string;
    reason: SessionHaltedPayload["reason"];
  }): Promise<void> {
    const startedAt = this.consumeActiveSessionStart(
      input.sessionId,
      input.timestamp,
    );

    if (this.pushService.getSubscriptionCount() === 0) {
      return;
    }

    if (!this.pushService.isNotificationTypeEnabled("sessionHalted")) {
      return;
    }

    const payload: SessionHaltedPayload = {
      type: "session-halted",
      sessionId: input.sessionId,
      projectId: input.projectId,
      projectName: this.getProjectName(input.projectId),
      reason: input.reason,
      duration: this.calculateDurationMs(startedAt, input.timestamp),
      timestamp: input.timestamp,
    };

    try {
      const results = await this.pushService.sendToAll(payload);
      const successCount = results.filter((result) => result.success).length;
      if (successCount > 0) {
        console.log(
          `[PushNotifier] Sent session-halted (${input.reason}) notification to ${successCount}/${results.length} devices`,
        );
      }
    } catch (error) {
      console.error(
        "[PushNotifier] Failed to send session-halted notification:",
        error,
      );
    }
  }

  /**
   * Remember when a session starts active work for the current turn.
   */
  private markSessionActive(sessionId: string, timestamp: string): void {
    if (!this.activeSessionStartedAt.has(sessionId)) {
      this.activeSessionStartedAt.set(sessionId, timestamp);
    }
  }

  /**
   * Consume the current active-run start time for a session.
   */
  private consumeActiveSessionStart(
    sessionId: string,
    fallbackTimestamp: string,
  ): string {
    const startedAt = this.activeSessionStartedAt.get(sessionId);
    this.activeSessionStartedAt.delete(sessionId);
    return startedAt ?? fallbackTimestamp;
  }

  /**
   * Calculate duration between two ISO timestamps.
   */
  private calculateDurationMs(startedAt: string, endedAt: string): number {
    const startMs = Date.parse(startedAt);
    const endMs = Date.parse(endedAt);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return 0;
    }
    return Math.max(0, endMs - startMs);
  }

  /**
   * Get project name from projectId.
   */
  private getProjectName(projectId: UrlProjectId): string {
    try {
      const projectPath = decodeProjectId(projectId);
      return basename(projectPath);
    } catch {
      return "Unknown Project";
    }
  }

  /**
   * Build a human-readable summary from the InputRequest.
   */
  private buildSummary(request: InputRequest): string {
    if (request.type === "tool-approval") {
      const toolName = request.toolName ?? "Unknown tool";

      // For file operations, try to extract the file path
      if (request.toolInput && typeof request.toolInput === "object") {
        const input = request.toolInput as Record<string, unknown>;
        const filePath = input.file_path ?? input.filePath ?? input.path;
        if (typeof filePath === "string") {
          // Extract just the filename from the path
          const fileName = basename(filePath);
          return `${toolName}: ${fileName}`;
        }
      }

      return `Run: ${toolName}`;
    }

    // For questions/choices, use the prompt text (truncated)
    const prompt = request.prompt ?? "Waiting for input";
    if (prompt.length > 60) {
      return `${prompt.slice(0, 57)}...`;
    }
    return prompt;
  }

  /**
   * Clean up EventBus subscription.
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
