/**
 * E2E tests for WebSocket transport (Phase 2b/2c).
 *
 * Tests the WebSocket relay functionality through a real browser:
 * - Request/response over WebSocket
 * - Event subscriptions (activity channel)
 * - Connection lifecycle
 *
 * Uses the production-like server setup from global-setup.ts which:
 * - Serves pre-built static files (no Vite dev server)
 * - Uses isolated test directories
 * - Includes ws-relay routes via dev-mock.ts
 */

import { expect, test } from "./fixtures.js";

// Type definitions for WebSocket relay protocol
interface RelayRequest {
  type: "request";
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface RelayResponse {
  type: "response";
  id: string;
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface RelaySubscribe {
  type: "subscribe";
  subscriptionId: string;
  channel: "session" | "activity";
  sessionId?: string;
  lastEventId?: string;
}

interface RelayUnsubscribe {
  type: "unsubscribe";
  subscriptionId: string;
}

interface RelayEvent {
  type: "event";
  subscriptionId: string;
  eventType: string;
  eventId: string;
  data: unknown;
}

test.describe("WebSocket Transport E2E", () => {
  test("can connect and make GET request for health endpoint", async ({
    page,
    baseURL,
  }) => {
    // Navigate to the app (needed to run in browser context)
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Test WebSocket relay in browser context
    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("WebSocket connection timeout"));
          }, 10000);

          ws.onopen = () => {
            // Send a health check request
            const request = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/health",
              headers: { "X-Yep-Anywhere": "true" },
            };

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.type === "response" && msg.id === request.id) {
                clearTimeout(timeout);
                ws.close();
                resolve({ status: msg.status, body: msg.body });
              }
            };

            ws.send(JSON.stringify(request));
          };

          ws.onerror = (event) => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        },
      );
    }, baseURL);

    expect(result.status).toBe(200);
    expect((result.body as { status: string }).status).toBe("ok");
  });

  test("can make GET request for version endpoint", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout"));
          }, 10000);

          ws.onopen = () => {
            const request = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/api/version",
              headers: { "X-Yep-Anywhere": "true" },
            };

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.type === "response" && msg.id === request.id) {
                clearTimeout(timeout);
                ws.close();
                resolve({ status: msg.status, body: msg.body });
              }
            };

            ws.send(JSON.stringify(request));
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        },
      );
    }, baseURL);

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("current");
  });

  test("can make GET request for projects endpoint", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout"));
          }, 10000);

          ws.onopen = () => {
            const request = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/api/projects",
              headers: { "X-Yep-Anywhere": "true" },
            };

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.type === "response" && msg.id === request.id) {
                clearTimeout(timeout);
                ws.close();
                resolve({ status: msg.status, body: msg.body });
              }
            };

            ws.send(JSON.stringify(request));
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        },
      );
    }, baseURL);

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("projects");
    expect(
      Array.isArray((result.body as { projects: unknown[] }).projects),
    ).toBe(true);
  });

  test("returns error status for non-existent endpoint", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{ status: number }>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("Timeout"));
        }, 10000);

        ws.onopen = () => {
          const request = {
            type: "request",
            id: crypto.randomUUID(),
            method: "GET",
            path: "/api/nonexistent",
            headers: { "X-Yep-Anywhere": "true" },
          };

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "response" && msg.id === request.id) {
              clearTimeout(timeout);
              ws.close();
              resolve({ status: msg.status });
            }
          };

          ws.send(JSON.stringify(request));
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket error"));
        };
      });
    }, baseURL);

    // Accept 404 (not found) or 500 (internal error from fallback routing)
    // The exact behavior depends on how the server handles non-existent routes
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  test("can handle multiple concurrent requests", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{ responses: Array<{ id: string; status: number }> }>(
        (resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout"));
          }, 10000);

          ws.onopen = () => {
            const request1 = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/health",
              headers: { "X-Yep-Anywhere": "true" },
            };

            const request2 = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/api/version",
              headers: { "X-Yep-Anywhere": "true" },
            };

            const responses: Array<{ id: string; status: number }> = [];

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.type === "response") {
                responses.push({ id: msg.id, status: msg.status });
                if (responses.length === 2) {
                  clearTimeout(timeout);
                  ws.close();
                  resolve({ responses });
                }
              }
            };

            // Send both requests concurrently
            ws.send(JSON.stringify(request1));
            ws.send(JSON.stringify(request2));
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        },
      );
    }, baseURL);

    expect(result.responses.length).toBe(2);
    expect(result.responses.every((r) => r.status === 200)).toBe(true);
  });

  test("can subscribe to activity channel and receive connected event", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{
        events: Array<{ eventType: string; subscriptionId: string }>;
      }>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("Timeout waiting for connected event"));
        }, 10000);

        ws.onopen = () => {
          const subscriptionId = crypto.randomUUID();
          const subscribe = {
            type: "subscribe",
            subscriptionId,
            channel: "activity",
          };

          const events: Array<{ eventType: string; subscriptionId: string }> =
            [];

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "event" && msg.subscriptionId === subscriptionId) {
              events.push({
                eventType: msg.eventType,
                subscriptionId: msg.subscriptionId,
              });
              // Wait for connected event
              if (msg.eventType === "connected") {
                clearTimeout(timeout);
                ws.close();
                resolve({ events });
              }
            }
          };

          ws.send(JSON.stringify(subscribe));
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket error"));
        };
      });
    }, baseURL);

    expect(result.events.length).toBe(1);
    expect(result.events[0].eventType).toBe("connected");
  });

  test("can unsubscribe from activity channel", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{ unsubscribed: boolean }>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          ws.close();
          // If we timed out without receiving events after unsubscribe, that's success
          resolve({ unsubscribed: true });
        }, 2000);

        ws.onopen = () => {
          const subscriptionId = crypto.randomUUID();
          const subscribe = {
            type: "subscribe",
            subscriptionId,
            channel: "activity",
          };

          let receivedConnected = false;

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "event" && msg.subscriptionId === subscriptionId) {
              if (msg.eventType === "connected") {
                receivedConnected = true;
                // Immediately unsubscribe
                const unsubscribe = {
                  type: "unsubscribe",
                  subscriptionId,
                };
                ws.send(JSON.stringify(unsubscribe));
              } else if (receivedConnected) {
                // Got an event after unsubscribe - that shouldn't happen
                clearTimeout(timeout);
                ws.close();
                resolve({ unsubscribed: false });
              }
            }
          };

          ws.send(JSON.stringify(subscribe));
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket error"));
        };
      });
    }, baseURL);

    expect(result.unsubscribed).toBe(true);
  });

  test("returns error for session subscription without sessionId", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      return new Promise<{ status: number; hasError: boolean }>(
        (resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout"));
          }, 10000);

          ws.onopen = () => {
            const subscriptionId = crypto.randomUUID();
            const subscribe = {
              type: "subscribe",
              subscriptionId,
              channel: "session",
              // Missing sessionId
            };

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              // Error response uses subscriptionId as the id
              if (msg.type === "response" && msg.id === subscriptionId) {
                clearTimeout(timeout);
                ws.close();
                resolve({
                  status: msg.status,
                  hasError: !!msg.body?.error,
                });
              }
            };

            ws.send(JSON.stringify(subscribe));
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        },
      );
    }, baseURL);

    expect(result.status).toBe(400);
    expect(result.hasError).toBe(true);
  });

  test("can reconnect after disconnection", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForLoadState("domcontentloaded");

    const result = await page.evaluate(async (url) => {
      const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

      // First connection
      const firstResponse = await new Promise<{ status: number }>(
        (resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout"));
          }, 10000);

          ws.onopen = () => {
            const request = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/health",
              headers: { "X-Yep-Anywhere": "true" },
            };

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.type === "response" && msg.id === request.id) {
                clearTimeout(timeout);
                ws.close();
                resolve({ status: msg.status });
              }
            };

            ws.send(JSON.stringify(request));
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        },
      );

      // Wait a bit for disconnect to process
      await new Promise((r) => setTimeout(r, 100));

      // Second connection
      const secondResponse = await new Promise<{ status: number }>(
        (resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout"));
          }, 10000);

          ws.onopen = () => {
            const request = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/health",
              headers: { "X-Yep-Anywhere": "true" },
            };

            ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              if (msg.type === "response" && msg.id === request.id) {
                clearTimeout(timeout);
                ws.close();
                resolve({ status: msg.status });
              }
            };

            ws.send(JSON.stringify(request));
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        },
      );

      return {
        firstStatus: firstResponse.status,
        secondStatus: secondResponse.status,
      };
    }, baseURL);

    expect(result.firstStatus).toBe(200);
    expect(result.secondStatus).toBe(200);
  });

  test.describe("Binary Frame Support (Phase 0)", () => {
    test("can send binary frame with format 0x01", async ({
      page,
      baseURL,
    }) => {
      await page.goto(`${baseURL}/`);
      await page.waitForLoadState("domcontentloaded");

      const result = await page.evaluate(async (url) => {
        const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

        // Helper to encode JSON as binary frame
        function encodeJsonFrame(message: unknown): ArrayBuffer {
          const json = JSON.stringify(message);
          const encoder = new TextEncoder();
          const jsonBytes = encoder.encode(json);
          const buffer = new ArrayBuffer(1 + jsonBytes.length);
          const view = new Uint8Array(buffer);
          view[0] = 0x01; // JSON format byte
          view.set(jsonBytes, 1);
          return buffer;
        }

        // Helper to decode binary frame
        function decodeJsonFrame<T>(data: ArrayBuffer): T {
          const bytes = new Uint8Array(data);
          if (bytes[0] !== 0x01) {
            throw new Error(`Unexpected format byte: ${bytes[0]}`);
          }
          const decoder = new TextDecoder();
          const json = decoder.decode(bytes.slice(1));
          return JSON.parse(json);
        }

        return new Promise<{ status: number; receivedBinary: boolean }>(
          (resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            ws.binaryType = "arraybuffer";
            const timeout = setTimeout(() => {
              ws.close();
              reject(new Error("Timeout"));
            }, 10000);

            ws.onopen = () => {
              const request = {
                type: "request",
                id: crypto.randomUUID(),
                method: "GET",
                path: "/health",
                headers: { "X-Yep-Anywhere": "true" },
              };

              let receivedBinary = false;

              ws.onmessage = (event) => {
                let msg: { type?: string; id?: string; status?: number };
                if (event.data instanceof ArrayBuffer) {
                  receivedBinary = true;
                  msg = decodeJsonFrame(event.data);
                } else {
                  msg = JSON.parse(event.data);
                }

                if (msg.type === "response" && msg.id === request.id) {
                  clearTimeout(timeout);
                  ws.close();
                  resolve({ status: msg.status ?? 0, receivedBinary });
                }
              };

              // Send as binary frame
              ws.send(encodeJsonFrame(request));
            };

            ws.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("WebSocket error"));
            };
          },
        );
      }, baseURL);

      expect(result.status).toBe(200);
      expect(result.receivedBinary).toBe(true);
    });

    test("can receive binary frame response", async ({ page, baseURL }) => {
      await page.goto(`${baseURL}/`);
      await page.waitForLoadState("domcontentloaded");

      const result = await page.evaluate(async (url) => {
        const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

        function encodeJsonFrame(message: unknown): ArrayBuffer {
          const json = JSON.stringify(message);
          const encoder = new TextEncoder();
          const jsonBytes = encoder.encode(json);
          const buffer = new ArrayBuffer(1 + jsonBytes.length);
          const view = new Uint8Array(buffer);
          view[0] = 0x01;
          view.set(jsonBytes, 1);
          return buffer;
        }

        function decodeJsonFrame<T>(data: ArrayBuffer): T {
          const bytes = new Uint8Array(data);
          if (bytes[0] !== 0x01) {
            throw new Error(`Unexpected format byte: ${bytes[0]}`);
          }
          const decoder = new TextDecoder();
          const json = decoder.decode(bytes.slice(1));
          return JSON.parse(json);
        }

        return new Promise<{ status: number; body: unknown }>(
          (resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            ws.binaryType = "arraybuffer";
            const timeout = setTimeout(() => {
              ws.close();
              reject(new Error("Timeout"));
            }, 10000);

            ws.onopen = () => {
              const request = {
                type: "request",
                id: crypto.randomUUID(),
                method: "GET",
                path: "/api/version",
                headers: { "X-Yep-Anywhere": "true" },
              };

              ws.onmessage = (event) => {
                let msg: {
                  type?: string;
                  id?: string;
                  status?: number;
                  body?: unknown;
                };
                if (event.data instanceof ArrayBuffer) {
                  msg = decodeJsonFrame(event.data);
                } else {
                  msg = JSON.parse(event.data);
                }

                if (msg.type === "response" && msg.id === request.id) {
                  clearTimeout(timeout);
                  ws.close();
                  resolve({ status: msg.status ?? 0, body: msg.body });
                }
              };

              ws.send(encodeJsonFrame(request));
            };

            ws.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("WebSocket error"));
            };
          },
        );
      }, baseURL);

      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("current");
    });

    test("handles ArrayBuffer correctly in browser", async ({
      page,
      baseURL,
    }) => {
      await page.goto(`${baseURL}/`);
      await page.waitForLoadState("domcontentloaded");

      const result = await page.evaluate(async (url) => {
        const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

        function encodeJsonFrame(message: unknown): ArrayBuffer {
          const json = JSON.stringify(message);
          const encoder = new TextEncoder();
          const jsonBytes = encoder.encode(json);
          const buffer = new ArrayBuffer(1 + jsonBytes.length);
          const view = new Uint8Array(buffer);
          view[0] = 0x01;
          view.set(jsonBytes, 1);
          return buffer;
        }

        return new Promise<{
          sentArrayBuffer: boolean;
          receivedArrayBuffer: boolean;
          responseValid: boolean;
        }>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          ws.binaryType = "arraybuffer";
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout"));
          }, 10000);

          ws.onopen = () => {
            const request = {
              type: "request",
              id: crypto.randomUUID(),
              method: "GET",
              path: "/health",
            };

            const binaryFrame = encodeJsonFrame(request);
            const sentArrayBuffer = binaryFrame instanceof ArrayBuffer;

            ws.onmessage = (event) => {
              const receivedArrayBuffer = event.data instanceof ArrayBuffer;
              let responseValid = false;

              if (receivedArrayBuffer) {
                const bytes = new Uint8Array(event.data);
                const formatByte = bytes[0];
                responseValid = formatByte === 0x01;
              }

              clearTimeout(timeout);
              ws.close();
              resolve({ sentArrayBuffer, receivedArrayBuffer, responseValid });
            };

            ws.send(binaryFrame);
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket error"));
          };
        });
      }, baseURL);

      expect(result.sentArrayBuffer).toBe(true);
      expect(result.receivedArrayBuffer).toBe(true);
      expect(result.responseValid).toBe(true);
    });

    test("handles UTF-8 content in binary frames", async ({
      page,
      baseURL,
    }) => {
      await page.goto(`${baseURL}/`);
      await page.waitForLoadState("domcontentloaded");

      const result = await page.evaluate(async (url) => {
        const wsUrl = `${url.replace("http://", "ws://")}/api/ws`;

        function encodeJsonFrame(message: unknown): ArrayBuffer {
          const json = JSON.stringify(message);
          const encoder = new TextEncoder();
          const jsonBytes = encoder.encode(json);
          const buffer = new ArrayBuffer(1 + jsonBytes.length);
          const view = new Uint8Array(buffer);
          view[0] = 0x01;
          view.set(jsonBytes, 1);
          return buffer;
        }

        function decodeJsonFrame<T>(data: ArrayBuffer): T {
          const bytes = new Uint8Array(data);
          const decoder = new TextDecoder();
          const json = decoder.decode(bytes.slice(1));
          return JSON.parse(json);
        }

        return new Promise<{ success: boolean; idMatches: boolean }>(
          (resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            ws.binaryType = "arraybuffer";
            const timeout = setTimeout(() => {
              ws.close();
              reject(new Error("Timeout"));
            }, 10000);

            ws.onopen = () => {
              // Test UTF-8 in the request ID - this tests that the binary frame
              // encoding/decoding properly handles Unicode characters in JSON content
              // (Note: HTTP headers don't support non-ASCII, so we test via the id field)
              const requestId = `utf8-test-${crypto.randomUUID()}-emoji-🎉-日本語`;
              const request = {
                type: "request",
                id: requestId,
                method: "GET",
                path: "/health",
              };

              ws.onmessage = (event) => {
                let msg: { type?: string; id?: string; status?: number };
                if (event.data instanceof ArrayBuffer) {
                  msg = decodeJsonFrame(event.data);
                } else {
                  msg = JSON.parse(event.data);
                }

                if (msg.type === "response" && msg.id === requestId) {
                  clearTimeout(timeout);
                  ws.close();
                  resolve({
                    success: msg.status === 200,
                    idMatches: msg.id === requestId,
                  });
                }
              };

              ws.send(encodeJsonFrame(request));
            };

            ws.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("WebSocket error"));
            };
          },
        );
      }, baseURL);

      expect(result.success).toBe(true);
      expect(result.idMatches).toBe(true);
    });
  });
});
