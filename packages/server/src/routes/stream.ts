import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type StreamAugmenter,
  createStreamAugmenter,
  extractIdFromAssistant,
  extractMessageIdFromStart,
  extractTextDelta,
  extractTextFromAssistant,
  isStreamingComplete,
  markSubagent,
} from "../augments/index.js";
import { getLogger } from "../logging/logger.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ProcessEvent } from "../supervisor/types.js";

export interface StreamDeps {
  supervisor: Supervisor;
}

export function createStreamRoutes(deps: StreamDeps): Hono {
  const routes = new Hono();

  // GET /api/sessions/:sessionId/stream - SSE endpoint
  routes.get("/sessions/:sessionId/stream", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let eventId = 0;
      const log = getLogger();

      // Track current streaming message ID for text accumulation
      let currentStreamingMessageId: string | null = null;

      // Create stream augmenter with SSE-specific emitters
      let augmenter: StreamAugmenter | null = null;
      const getAugmenter = async (): Promise<StreamAugmenter> => {
        if (augmenter) return augmenter;
        augmenter = await createStreamAugmenter({
          onMarkdownAugment: (data) => {
            stream
              .writeSSE({
                id: String(eventId++),
                event: "markdown-augment",
                data: JSON.stringify(data),
              })
              .catch(() => {
                // Stream closed
              });
          },
          onPending: (data) => {
            stream
              .writeSSE({
                id: String(eventId++),
                event: "pending",
                data: JSON.stringify(data),
              })
              .catch(() => {
                // Stream closed
              });
          },
          onError: (err, context) => {
            log.warn({ err, sessionId }, context);
          },
        });
        return augmenter;
      };

      // Heartbeat interval
      const heartbeatInterval = setInterval(async () => {
        try {
          await stream.writeSSE({
            id: String(eventId++),
            event: "heartbeat",
            data: JSON.stringify({ timestamp: new Date().toISOString() }),
          });
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 30000); // 30 second heartbeat

      let completed = false;

      // IMPORTANT: Subscribe to process events BEFORE capturing state for "connected" event
      // This prevents a race condition where the process transitions to waiting-input
      // during the message replay loop, causing the state-change event to be lost.
      // By subscribing first, any state change is guaranteed to either:
      // 1. Be captured in our state snapshot below (if it happened before)
      // 2. Be received by this subscriber (if it happened after)
      const unsubscribe = process.subscribe(async (event: ProcessEvent) => {
        if (completed) return;

        try {
          switch (event.type) {
            case "message": {
              const message = event.message as Record<string, unknown>;

              // Process all augments (Edit, Write, Read, ExitPlanMode, final markdown)
              // This mutates the message and emits markdown-augment events
              const aug = await getAugmenter();
              await aug.processMessage(message);

              // Send the message to client (raw text delivery)
              await stream.writeSSE({
                id: String(eventId++),
                event: "message",
                data: JSON.stringify(markSubagent(event.message)),
              });

              // Track message ID for text accumulation (for catch-up)
              const startMessageId =
                extractMessageIdFromStart(message) ??
                extractIdFromAssistant(message);
              if (startMessageId) {
                currentStreamingMessageId = startMessageId;
              }

              // Accumulate text for late-joining clients
              const textDelta =
                extractTextDelta(message) ?? extractTextFromAssistant(message);
              if (textDelta && currentStreamingMessageId) {
                process.accumulateStreamingText(
                  currentStreamingMessageId,
                  textDelta,
                );
              }

              // Clear accumulated text when streaming ends
              if (isStreamingComplete(message)) {
                currentStreamingMessageId = null;
                process.clearStreamingText();
              }
              break;
            }

            case "state-change":
              log.info(
                {
                  component: "sse-stream",
                  sessionId,
                  eventType: "state-change",
                  newState: event.state.type,
                  hasRequest: event.state.type === "waiting-input",
                },
                "Sending SSE status event",
              );
              await stream.writeSSE({
                id: String(eventId++),
                event: "status",
                data: JSON.stringify({
                  state: event.state.type,
                  ...(event.state.type === "waiting-input"
                    ? { request: event.state.request }
                    : {}),
                }),
              });
              break;

            case "mode-change":
              await stream.writeSSE({
                id: String(eventId++),
                event: "mode-change",
                data: JSON.stringify({
                  permissionMode: event.mode,
                  modeVersion: event.version,
                }),
              });
              break;

            case "error":
              await stream.writeSSE({
                id: String(eventId++),
                event: "error",
                data: JSON.stringify({ message: event.error.message }),
              });
              break;

            case "claude-login":
              // Emit Claude login events for re-authentication flow
              await stream.writeSSE({
                id: String(eventId++),
                event: "claude-login",
                data: JSON.stringify(event.event),
              });
              break;

            case "session-id-changed":
              // Notify client when temp session ID is replaced with real SDK session ID
              // Client should update URL/state to use new session ID
              await stream.writeSSE({
                id: String(eventId++),
                event: "session-id-changed",
                data: JSON.stringify({
                  oldSessionId: event.oldSessionId,
                  newSessionId: event.newSessionId,
                }),
              });
              break;

            case "complete":
              // Flush any remaining augments before completing
              if (augmenter) {
                await augmenter.flush();
              }

              await stream.writeSSE({
                id: String(eventId++),
                event: "complete",
                data: JSON.stringify({ timestamp: new Date().toISOString() }),
              });
              completed = true;
              clearInterval(heartbeatInterval);
              break;
          }
        } catch {
          // Stream closed
          completed = true;
          clearInterval(heartbeatInterval);
          unsubscribe();
        }
      });

      // Now that we're subscribed, capture current state and send "connected" event
      // Any state changes after this point will be received by the subscriber above
      const currentState = process.state;
      log.info(
        {
          component: "sse-stream",
          sessionId,
          eventType: "connected",
          currentState: currentState.type,
          hasRequest:
            currentState.type === "waiting-input" && !!currentState.request,
        },
        "Sending SSE connected event",
      );
      await stream.writeSSE({
        id: String(eventId++),
        event: "connected",
        data: JSON.stringify({
          processId: process.id,
          sessionId: process.sessionId,
          state: currentState.type,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
          // Include provider and model for immediate UI display (belt-and-suspenders)
          provider: process.provider,
          model: process.model,
          // Include pending request for waiting-input state
          ...(currentState.type === "waiting-input"
            ? { request: currentState.request }
            : {}),
        }),
      });

      // Replay buffered messages (for mock SDK that doesn't persist to disk)
      // This ensures clients that connect after messages were emitted still receive them
      for (const message of process.getMessageHistory()) {
        await stream.writeSSE({
          id: String(eventId++),
          event: "message",
          data: JSON.stringify(markSubagent(message)),
        });
      }

      // Catch-up: send accumulated streaming text as pending HTML for late-joining clients
      // This ensures clients that connect mid-stream see all content, not just from join point
      const streamingContent = process.getStreamingContent();
      if (streamingContent) {
        try {
          const aug = await getAugmenter();
          await aug.processCatchUp(
            streamingContent.text,
            streamingContent.messageId,
          );
        } catch (err) {
          log.warn({ err, sessionId }, "Failed to send catch-up pending HTML");
        }
      }

      // Keep stream open until process completes or client disconnects
      await new Promise<void>((resolve) => {
        // Also resolve if already completed (process finished before we got here)
        if (completed) {
          resolve();
          return;
        }

        // Subscribe to wait for completion
        const unsubscribeCompletion = process.subscribe((event) => {
          if (event.type === "complete") {
            unsubscribeCompletion();
            resolve();
          }
        });

        // Handle stream close - must unsubscribe the completion listener too
        stream.onAbort(() => {
          completed = true;
          clearInterval(heartbeatInterval);
          unsubscribe();
          unsubscribeCompletion(); // Clean up completion listener on disconnect
          resolve();
        });

        // Check again after subscribing in case we missed it
        if (completed) {
          unsubscribeCompletion();
          resolve();
        }
      });
    });
  });

  return routes;
}
